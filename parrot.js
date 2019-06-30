const path = require('path');
process.env['GOOGLE_APPLICATION_CREDENTIALS'] = path.resolve(__dirname, 'google_app_credentials.json')

const http = require('http');
const url = require('url');
const stream = require('stream');
const anchorme = require("anchorme").default;
const rimraf = require('rimraf');
const textToSpeech = require('@google-cloud/text-to-speech');

const Discord = require('discord.js');
const client = new Discord.Client();
const ttsClient = new textToSpeech.TextToSpeechClient();

const queuedMessages = {};
const busy = {};
const currentStreamDispatcher = {};
const lastMessageTimeouts = {};

let voicesCache = [];
let voicesCacheLastUpdate = 0;

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
  const filterVoices = voices => {
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
  }
  const now = Date.now();
  if (voicesCache.length == 0 || now - voicesCacheLastUpdate > 6.048e8) {
    ttsClient
    .listVoices({})
    .then(results => {
      voicesCache = results[0].voices;
      voicesCacheLastUpdate = now;
      filterVoices(voicesCache);
    });
  } else {
    filterVoices(voicesCache);
  }
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
  const voiceChannel = msg.member.voice.channel;
  const guild = msg.member.guild;
  const serverId = guild.id;
  if (queuedMessages[serverId] === undefined) {
    queuedMessages[serverId] = [];
  }
  if (msg.cleanContent.substring(0, 1) == '!') {
    let args = msg.cleanContent.substring(1).split(' ');
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
          currentStreamDispatcher[serverId] = null;
        }
        break;
      case 'clear':
        while (queuedMessages[serverId].length > 0) {
          queuedMessages[serverId].pop();
        }
        if (currentStreamDispatcher[serverId]) {
          currentStreamDispatcher[serverId].end();
          currentStreamDispatcher[serverId] = null;
        }
        break;
      case 'leave':
        if (guild.voiceConnection) {
          guild.voiceConnection.disconnect();
        }
        break;
      case 'random':
        randomizeLanguage(msg.author.id, (languageCode, voice) => {
          msg.channel.send('Voice changed to ' + voice + ' for ' + msg.author.username);
        }, {type: 'Wavenet'});
        break;
      case 'voice':
        inputs = msg.cleanContent.split('!voice ');
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
                  msg.channel.send('Voice set to ' + v.name + ' for ' + msg.author.username);
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
            input: {text: sanitizeText(msg.cleanContent)},
            voice: voiceObj,
            audioConfig: {audioEncoding: 'OGG_OPUS'},
          };
          ttsClient.synthesizeSpeech(request, (err, response) => {
            if (err) {
              console.error('ERROR:', err);
              playbackFinished(guild);
              return;
            }
            
            if (currentStreamDispatcher[serverId]) {
              currentStreamDispatcher[serverId].end();
              currentStreamDispatcher[serverId] = null;
            }

            const readableInstanceStream = new stream.Readable({
              read() {
                this.push(response.audioContent);
                this.push(null);
              }
            });
            currentStreamDispatcher[serverId] = connection.play(readableInstanceStream);
            currentStreamDispatcher[serverId].on('error', err => {
              console.error('ERROR:', err);
              currentStreamDispatcher[serverId] = null;
              playbackFinished(guild);
            });
            currentStreamDispatcher[serverId].on('end', end => {
              currentStreamDispatcher[serverId] = null;
              playbackFinished(guild);
            });
          });
        }).catch(err => {
          console.log(err);
          playbackFinished(guild);
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

function sanitizeText(cleanContent) {
  const results = anchorme(cleanContent, {
    emails: false,
    files: false,
    list: true
  });
  for (var i = 0; i < results.length; i++) {
    let hostname = url.parse(results[i].protocol + results[i].encoded).hostname;
    if (!hostname) {
      continue;
    }
    cleanContent = cleanContent.replace(results[i].raw, hostname.startsWith('www.') ? hostname.substring(4) : hostname);
  }
  return cleanContent;
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
  processMessageQueue(guild.id);
  maybeLeaveVoice(guild);
  startTimeout(guild);
}

client.login(process.env.DISCORD_TOKEN || require('./auth.json').token);

const port = 8080

const requestHandler = (request, response) => {
  response.end('Parrot Bot is running!')
}

const server = http.createServer(requestHandler)

server.listen(port, (err) => {
  console.log(`server is listening on ${port}`)
})
