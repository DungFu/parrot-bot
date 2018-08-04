const path = require('path');
process.env['GOOGLE_APPLICATION_CREDENTIALS'] = path.resolve(__dirname, 'google_app_credentials.json')

const fs = require('fs');
const rimraf = require('rimraf');
const uuidv4 = require('uuid/v4');
const textToSpeech = require('@google-cloud/text-to-speech');

const Discord = require('discord.js');
const client = new Discord.Client();
const ttsClient = new textToSpeech.TextToSpeechClient();

const audioTempDir = './temp';

const queuedMessages = {};
const busy = {};
const currentStreamDispatcher = {};
const lastMessageTimeouts = {};

const sqlite3 = require('sqlite3').verbose();
const db = new sqlite3.Database('parrotbot.db');

const TIMEOUT_DISCONNECT = 15 * 60 * 1000; // 15 min

db.run("CREATE TABLE IF NOT EXISTS Users(id TEXT PRIMARY KEY, language TEXT, voice TEXT, tts_enabled BOOL)");

client.on('ready', () => {
  console.log(`Logged in as ${client.user.tag}!`);
});

client.on('message', msg => {
  processMessage(msg);
});

client.on('voiceStateUpdate', (oldMember, newMember) => {
  if (newMember.voiceChannel === undefined) {
    maybeLeaveVoice(newMember.guild);
  }
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
  const guild = msg.member.guild;
  const serverId = guild.id;
  if (queuedMessages[serverId] === undefined) {
    queuedMessages[serverId] = [];
  }
  if (msg.content.substring(0, 1) == '!') {
    let args = msg.content.substring(1).split(' ');
    let cmd = args[0];

    let inputs;

    args = args.splice(1);
    switch (cmd) {
      case 'tts':
        toggleUserTtsEnabled(msg.author.id, tts_enabled => {
          msg.channel.send('Text to speech ' + (tts_enabled ? 'enabled' : 'disabled') + ' for ' + msg.author.username);
          maybeLeaveVoice(guild);
        });
        break;
      case 'stop':
        if (currentStreamDispatcher[serverId]) {
          currentStreamDispatcher[serverId].end();
        }
        break;
      case 'clear':
        while (queuedMessages[serverId].length > 0) {
          queuedMessages[serverId].pop();
        }
        if (currentStreamDispatcher[serverId]) {
          currentStreamDispatcher[serverId].end();
        }
        break;
      case 'leave':
        if (guild.voiceConnection) {
          guild.voiceConnection.disconnect();
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
            for (let i = 0; i < voices.length; i++) {
              const v = voices[i];
              if (v.name == inputs[1]) {
                let languageCode = v.languageCodes[0];
                db.run('UPDATE Users SET language = ?, voice = ? WHERE id = ?', [languageCode, v.name, msg.author.id], function(err) {
                  if (err) {
                    return console.log(err.message);
                  }
                  msg.channel.send('Voice set to ' + v.name);
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
          !leave : forces parrot bot to leave the voice channel
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
        if (busy[serverId]) {
          queuedMessages[serverId].push(msg);
          return;
        }
        busy[serverId] = true;
        voiceChannel.join().then(connection => {
          const voiceObj = {languageCode: user.language, name: user.voice};
          const request = {
            input: {text: msg.content},
            voice: voiceObj,
            audioConfig: {audioEncoding: 'OGG_OPUS'},
          };
          ttsClient.synthesizeSpeech(request, (err, response) => {
            if (err) {
              console.error('ERROR:', err);
              playbackFinished(guild);
              return;
            }

            if (!fs.existsSync(audioTempDir)) {
              fs.mkdirSync(audioTempDir);
            }
           
            // Write the binary audio content to a local file
            const filename = uuidv4() + '.ogg';
            const filepath = path.join(audioTempDir, filename);
            fs.writeFile(filepath, response.audioContent, 'binary', err => {
              if (err) {
                console.error('ERROR:', err);
                playbackFinished(guild);
                return;
              }
              if (currentStreamDispatcher[serverId]) {
                currentStreamDispatcher[serverId].end();
              }
              currentStreamDispatcher[serverId] = connection.playFile(filepath, { type: 'ogg/opus' });
              currentStreamDispatcher[serverId].on('error', err => {
                console.error('ERROR:', err);
                currentStreamDispatcher[serverId].end();
              });
              currentStreamDispatcher[serverId].on('end', end => {
                currentStreamDispatcher[serverId] = null;
                playbackFinished(guild);
              });
            });
          });
        }).catch(err => {
          console.log(err);
          busy[serverId] = false;
          processMessageQueue(serverId);
          maybeLeaveVoice(guild);
        });
      }
    });
  }
}

function maybeLeaveVoice(guild) {
  const userIds = [];
  guild.members.forEach(function(guildMember, guildMemberId) {
    if (guildMember.voiceChannelID) {
      userIds.push(guildMemberId);
    }
  })
  if (userIds.length === 0) {
    if (guild.voiceConnection) {
      guild.voiceConnection.disconnect();
    }
    return;
  }
  db.all(
    'SELECT * FROM Users WHERE tts_enabled = ? AND id IN ( ' + userIds.map(function(){ return '?' }).join(',') + ' )', [true].concat(userIds), function(err, rows) {
    if (err) {
      return console.log(err.message);
    }
    if (rows.length === 0 && guild.voiceConnection) {
      guild.voiceConnection.disconnect();
    }
  });
}

function processMessageQueue(serverId) {
  if (queuedMessages[serverId].length > 0) {
    processMessage(queuedMessages[serverId].shift());
    if (!busy[serverId]) {
      processMessageQueue(serverId);
    }
  }
}

function deleteOldFiles() {
  fs.readdir(audioTempDir, function(err, files) {
    files.forEach(function(file, index) {
      fs.stat(path.join(audioTempDir, file), function(err, stat) {
        let endTime, now;
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

function startTimeout(guild) {
  if (lastMessageTimeouts[guild.id]) {
    clearTimeout(lastMessageTimeouts[guild.id]);
    lastMessageTimeouts[guild.id] = null;
  }
  lastMessageTimeouts[guild.id] = client.setInterval(() => {
    if (guild.voiceConnection) {
      guild.voiceConnection.disconnect();
    }
    lastMessageTimeouts[guild.id] = null;
  }, TIMEOUT_DISCONNECT);
}

function playbackFinished(guild) {
  busy[guild.id] = false;
  deleteOldFiles();
  processMessageQueue(guild.id);
  maybeLeaveVoice(guild);
  startTimeout(guild);
}

client.login(process.env.DISCORD_TOKEN || require('./auth.json').token);
