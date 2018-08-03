const path = require('path');
process.env['GOOGLE_APPLICATION_CREDENTIALS'] = path.resolve(__dirname, 'google_app_credentials.json')

const fs = require('fs');
const rimraf = require('rimraf');
const auth = require('./auth.json');
const uuidv4 = require('uuid/v4');
const textToSpeech = require('@google-cloud/text-to-speech');

const Discord = require('discord.js');
const client = new Discord.Client();
const ttsClient = new textToSpeech.TextToSpeechClient();

const audioTempDir = './temp';

const queuedMessages = [];

let busy = false;
let currentStreamDispatcher = null;

const sqlite3 = require('sqlite3').verbose();
const db = new sqlite3.Database('parrotbot.db');

db.run("CREATE TABLE IF NOT EXISTS Users(id TEXT PRIMARY KEY, language TEXT, voice TEXT, tts_enabled BOOL)");

client.on('ready', () => {
  console.log(`Logged in as ${client.user.tag}!`);
});

client.on('message', msg => {
  processMessage(msg);
});

client.on('error', console.error);

function getValidVoices(callback, options = {}) {
  ttsClient
    .listVoices({})
    .then(results => {
      const voices = results[0].voices;
      let filteredVoices = null;
      if (options.languageCode) {
        filteredVoices =
          (filteredVoices === null ? voices : filteredVoices).filter(v => {
            return v.languageCodes.indexOf(options.languageCode) > -1
          });
      }
      if (options.type) {
        filteredVoices =
          (filteredVoices === null ? voices : filteredVoices).filter(v => {
            return v.name.includes(options.type)
          });
      }
      if (filteredVoices === null) {
        callback(voices);
      } else {
        callback(filteredVoices);
      }
    });
}

function getUser(userId, callback) {
  db.get('SELECT * FROM Users WHERE id = ?', [userId], function(err, row) {
    if (err) {
      return console.log(err.message);
    }
    callback(row);
  });
}

function getOrCreateUser(userId, callback) {
  db.get('SELECT * FROM Users WHERE id = ?', [userId], function(err, row) {
    if (err) {
      return console.log(err.message);
    }
    if (row) {
      callback(row);
    } else {
      getValidVoices(voices => {
        const randomVoice = voices[Math.floor(Math.random()*voices.length)];
        const languageCode = randomVoice.languageCodes[0];
        db.run('INSERT INTO Users VALUES(?, ?, ?, ?)', [userId, languageCode, randomVoice.name, false], function(err) {
          if (err) {
            return console.log(err.message);
          }
          console.log('New user with ' + randomVoice.name);
          callback({id: userId, language: languageCode, voice: randomVoice.name, tts_enabled: false});
        });
      }, {languageCode: 'en-US', type: 'Wavenet'});
    }
  });
}

function getUserTtsEnabled(userId, callback) {
  getOrCreateUser(userId, user => {
    callback(user.tts_enabled);
  });
}

function getUserVoice(userId, callback) {
  getOrCreateUser(userId, user => {
    callback(user.voice);
  });
}

function toggleUserTtsEnabled(userId, callback) {
  getOrCreateUser(userId, user => {
    const newTtsEnabled = !user.tts_enabled;
    db.run('UPDATE Users SET tts_enabled = ? WHERE id = ?', [newTtsEnabled, userId], function(err) {
      if (err) {
        return console.log(err.message);
      }
      callback(newTtsEnabled);
    });
  });
}

function randomizeLanguage(userId, callback, options = {}) {
  getOrCreateUser(userId, user => {
    getValidVoices(voices => {
      const randomVoice = voices[Math.floor(Math.random()*voices.length)];
      const languageCode = randomVoice.languageCodes[0];
      db.run('UPDATE Users SET language = ?, voice = ? WHERE id = ?', [languageCode, randomVoice.name, userId], function(err) {
        if (err) {
          return console.log(err.message);
        }
        callback(languageCode, randomVoice.name);
      });
    }, options)
  });
}

function setVoice(userId, voice, callback, options = {}) {
  getOrCreateUser(userId, user => {
    getValidVoices(voices => {

      const randomVoice = voices[Math.floor(Math.random()*voices.length)];
      const languageCode = randomVoice.languageCodes[0];
      db.run('UPDATE Users SET language = ?, voice = ? WHERE id = ?', [languageCode, randomVoice.name, userId], function(err) {
        if (err) {
          return console.log(err.message);
        }
        callback(languageCode, randomVoice.name);
      });
    }, options)
  });
}

function processMessage(msg) {
  const voiceChannel = msg.member.voiceChannel;
  if (msg.content.substring(0, 1) == '!') {
    var args = msg.content.substring(1).split(' ');
    var cmd = args[0];

    let inputs;

    args = args.splice(1);
    switch (cmd) {
      case 'tts':
        toggleUserTtsEnabled(msg.author.id, tts_enabled => {
          msg.channel.send('Text to speech ' + (tts_enabled ? 'enabled' : 'disabled') + ' for ' + msg.author.username);
          maybeLeaveVoice(voiceChannel);
        });
        break;
      case 'stop':
        if (currentStreamDispatcher !== null) {
          currentStreamDispatcher.end();
        }
        break;
      case 'clear':
        while (queuedMessages.length > 0) {
          queuedMessages.pop();
        }
        if (currentStreamDispatcher !== null) {
          currentStreamDispatcher.end();
        }
        break;
      case 'random':
        randomizeLanguage(msg.author.id, (languageCode, voice) => {
          msg.channel.send('Language changed to ' + voice);
        }, {type: 'Wavenet'});
        break;
      case 'voice':
        inputs = msg.content.split('!voice ');
        if (inputs.length > 1) {
          getValidVoices(voices => {
            for (var i = 0; i < voices.length; i++) {
              const v = voices[i];
              if (v.name == inputs[1]) {
                voice = v.name;
                languageCode = v.languageCodes[0];
                db.run('UPDATE Users SET language = ?, voice = ? WHERE id = ?', [languageCode, v.name, msg.author.id], function(err) {
                  if (err) {
                    return console.log(err.message);
                  }
                  msg.channel.send('Voice set to ' + voice);
                });              
                return;
              }
            }
            msg.channel.send('Not a valid voice: ' + inputs[1]);
          });
        } else {
          getOrCreateUser(msg.author.id, user => {
            msg.channel.send('Current voice: ' + user.voice);
          });
        }
        break;
      case 'settings':
        msg.channel.send(`
          Settings for ParrotBot

          !tts : enabled/disable text to speech
          !stop : stop playing current text to speech message
          !clear : stop playing current message and cancel all messages in the queue
          !random : choose a random new voice
          
          The next settings all relate to the voice
          See: https://cloud.google.com/text-to-speech/docs/voices
          -------------------
          !voice : The voice name (ex: en-US-Wavenet-A)
        `);
        break;
    }
  } else if (voiceChannel) {
    getUser(msg.author.id, user => {
      if (user && user.tts_enabled) {
        if (busy) {
          queuedMessages.push(msg);
          return;
        }
        busy = true;
        voiceChannel.join().then(connection => {
          const voiceObj = {languageCode: user.language, name: user.voice};
          const request = {
            input: {text: msg.content},
            voice: voiceObj,
            audioConfig: {audioEncoding: 'MP3'},
          };
          ttsClient.synthesizeSpeech(request, (err, response) => {
            if (err) {
              console.error('ERROR:', err);
              busy = false;
              processMessageQueue();
              maybeLeaveVoice(voiceChannel);
              return;
            }

            if (!fs.existsSync(audioTempDir)) {
              fs.mkdirSync(audioTempDir);
            }
           
            // Write the binary audio content to a local file
            const filename = uuidv4() + '.mp3';
            const filepath = path.join(audioTempDir, filename);
            fs.writeFile(filepath, response.audioContent, 'binary', err => {
              if (err) {
                console.error('ERROR:', err);
                busy = false;
                processMessageQueue();
                maybeLeaveVoice(voiceChannel);
                return;
              }
              if (currentStreamDispatcher !== null) {
                currentStreamDispatcher.end();
              }
              currentStreamDispatcher = connection.playFile(filepath);
              currentStreamDispatcher.on("end", end => {
                busy = false;
                currentStreamDispatcher = null;
                deleteOldFiles();
                processMessageQueue();
                maybeLeaveVoice(voiceChannel);
              });
            });
          });
        }).catch(err => {
          console.log(err);
          busy = false;
          processMessageQueue();
          maybeLeaveVoice(voiceChannel);
        });
      }
    });
  }
}

function maybeLeaveVoice(voiceChannel) {
  db.all('SELECT * FROM Users WHERE tts_enabled = ?', [true], function(err, rows) {
    if (err) {
      return console.log(err.message);
    }
    if (rows.length === 0) {
      voiceChannel.join().then(connection => {
        voiceChannel.leave();
      });
    }
  });
}

function processMessageQueue() {
  if (queuedMessages.length > 0) {
    processMessage(queuedMessages.shift());
    if (!busy) {
      processMessageQueue();
    }
  }
}

function deleteOldFiles() {
  fs.readdir(audioTempDir, function(err, files) {
    files.forEach(function(file, index) {
      fs.stat(path.join(audioTempDir, file), function(err, stat) {
        var endTime, now;
        if (err) {
          return console.error(err);
        }
        now = new Date().getTime();
        endTime = new Date(stat.ctime).getTime() + 300000;
        if (now > endTime) {
          return rimraf(path.join(audioTempDir, file), function(err) {
            if (err) {
              return console.error(err);
            }
          });
        }
      });
    });
  });
}

client.login(auth.token);
