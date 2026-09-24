require('dotenv').config();
const tmi = require('tmi.js');
const fastify = require('fastify')({ logger: false });
const path = require('path');
const { Agent, setGlobalDispatcher } = require('undici');
const { OpenAI } = require('openai');

fastify.register(require('@fastify/static'), {
  root: path.join(__dirname, 'public'),
});

setGlobalDispatcher(new Agent({
  headersTimeout: 30 * 60 * 1000, // 30 min
  bodyTimeout: 30 * 60 * 1000,
}));

// ---------------------------------------------------------------------------
// Serial queue for the local LLM endpoint.
//
// Multiple chat messages can trigger fetch() calls to the LLM server at
// nearly the same time. Without a queue, they all fire concurrently. This
// AsyncQueue makes sure each call to that endpoint waits for the previous
// one to finish before starting, so 3 fetches "at once" become 3 fetches
// run one after another instead of racing each other.
// ---------------------------------------------------------------------------
class AsyncQueue {
  constructor() {
    this._tail = Promise.resolve();
  }

  // Runs `task` (a function returning a Promise) only after everything
  // already queued has settled, and returns whatever that task resolves
  // or rejects with.
  enqueue(task) {
    const run = this._tail.then(task, task);
    // Keep the chain alive even if a task throws, so one failed request
    // doesn't permanently jam the queue for everyone after it.
    this._tail = run.then(() => undefined, () => undefined);
    return run;
  }
}

const llmQueue = new AsyncQueue();
const LLM_ENDPOINT = 'http://192.168.31.220:3001/api/chat/completions';
const NINEROUTER_ENDPOINT = 'http://192.168.31.220:20128/v1';
const EMOTES_ENDPOINT = 'https://mergechat.pwisetthon.com/emotes';
const STATUS_ENDPOINT = 'https://localpost.teamquadb.in.th/twitchstatus';
const TWITCH_CLIENT_ID = process.env.TWITCH_CLIENT_ID || 'gp762nuuoqcoxypju8c569th9wz7q5';
const followerCache = new Map();
const FOLLOWER_CACHE_TTL = 5 * 60 * 1000;
let emoteNames = new Set();

async function loadEmotes() {
  try {
    const response = await fetch(EMOTES_ENDPOINT);
    if (!response.ok) {
      throw new Error(`Emote request failed: ${response.status} ${response.statusText}`);
    }

    const emotes = await response.json();
    emoteNames = new Set(Object.keys(emotes));
    console.log(`Loaded ${emoteNames.size} emotes`);
  } catch (error) {
    console.error('Failed to load emotes:', error);
  }
}

async function getLiveGameName() {
  try {
    const response = await fetch(STATUS_ENDPOINT);
    if (!response.ok) {
      throw new Error(`Status request failed: ${response.status} ${response.statusText}`);
    }
    const data = await response.json();
    return data.game_name;
  } catch (error) {
    console.error('Failed to fetch live game name:', error);
    return null;
  }
}

async function sendGameFunFact(client, channels) {
  const gameName = await getLiveGameName();
  if (!gameName) {
    console.log('Could not determine live game name, skipping fun fact.');
    return;
  }

  try {
    let funFact = '';
    if (process.env.mode === 'ninerouter') {
      const openai = new OpenAI({
        baseURL: NINEROUTER_ENDPOINT,
        apiKey: process.env.NINEROUTER_API_KEY,
      });

      const response = await openai.chat.completions.create({
        model: 'foranswerbasicquestions',
        messages: [
          { role: 'system', content: 'คุณเป็นผู้เชี่ยวชาญด้านเกม ให้ข้อเท็จจริงที่น่าสนใจ (fun fact) สั้นๆ เกี่ยวกับเกมที่ระบุ ตอบเป็นภาษาไทย กระชับ 1-2 ประโยค ห้ามใช้ markdown' },
          { role: 'user', content: `Tell me a fun fact about the game: ${gameName}` }
        ],
      });
      funFact = response.choices[0].message.content;
    } else {
      const raw = JSON.stringify({
        "model": "gemma3ne2b-fortwitchchat",
        "messages": [
          {
            "role": "system",
            "content": "คุณเป็นผู้เชี่ยวชาญด้านเกม ให้ข้อเท็จจริงที่น่าสนใจ (fun fact) สั้นๆ เกี่ยวกับเกมที่ระบุ ตอบเป็นภาษาไทย กระชับ 1-2 ประโยค ห้ามใช้ markdown"
          },
          {
            "role": "user",
            "content": `Tell me a fun fact about the game: ${gameName}`
          }
        ]
      });

      const requestOptions = {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": "Bearer " + process.env.LOCALLLM_API_KEY
        },
        body: raw,
        redirect: "manual",
        signal: AbortSignal.timeout(30 * 60 * 1000)
      };

      const response = await queuedFetch(LLM_ENDPOINT, requestOptions);
      const result = await response.text();
      const res = JSON.parse(result);
      funFact = res.choices[0].message.content;
    }

    if (funFact) {
      for (const channel of channels) {
        client.say(channel, `🎮 Fun Fact about ${gameName}: ${funFact}`);
      }
    }
  } catch (error) {
    console.error('Error generating game fun fact:', error);
  }
}

function messageContainsEmote(message) {
  return message.split(/\s+/).some((word) => emoteNames.has(word));
}

async function getTwitchUserId(login) {
  const params = new URLSearchParams({ login });
  const response = await fetch(`https://api.twitch.tv/helix/users?${params}`, {
    headers: {
      'Client-ID': TWITCH_CLIENT_ID,
      'Authorization': 'Bearer ' + process.env.TWITCH_OAUTH_TOKEN.replace('oauth:', ''),
    },
  });

  if (!response.ok) {
    throw new Error(`User lookup failed: ${response.status} ${response.statusText}`);
  }

  const result = await response.json();
  return result.data?.[0]?.id;
}

async function userFollowsChannel(tags) {
  const broadcasterId = tags['room-id'];
  const userId = tags['user-id'];
  if (!broadcasterId || !userId || !process.env.TWITCH_OAUTH_TOKEN) {
    return false;
  }

  const cacheKey = `${broadcasterId}:${userId}`;
  const cached = followerCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.isFollower;
  }

  const params = new URLSearchParams({
    broadcaster_id: broadcasterId,
    user_id: userId,
  });

  try {
    const response = await fetch(`https://api.twitch.tv/helix/channels/followers?${params}`, {
      headers: {
        'Client-ID': TWITCH_CLIENT_ID,
        'Authorization': 'Bearer ' + process.env.TWITCH_OAUTH_TOKEN.replace('oauth:', ''),
      },
    });

    if (!response.ok) {
      // throw new Error(`Follower request failed: ${response.status} ${response.statusText}`);
      console.error(`Follower request failed: ${response.status} ${response.statusText}`);
      return false;
    }

    const result = await response.json();
    const isFollower = result.data?.some((follower) => follower.user_id === userId) || false;
    followerCache.set(cacheKey, {
      isFollower,
      expiresAt: Date.now() + FOLLOWER_CACHE_TTL,
    });
    return isFollower;
  } catch (error) {
    console.error(`Failed to check follower status for ${tags.username}:`, error);
    return false;
  }
}

// Drop-in replacement for fetch() against the LLM endpoint: same signature,
// same return value (a Promise<Response>), but serialized through llmQueue.
function queuedFetch(url, options) {
  return llmQueue.enqueue(() => fetch(url, options));
}

let viewerlist = [];
const dontshow = ['nightbot', 'streamelements', 'moobot', 'trackerggbot', 'boyalone99', 'kofistreambot', process.env.TWITCH_USERNAME];

(async () => {
  await loadEmotes();

  const twitchrefresh = await fetch('https://twitchtokengenerator.com/api/refresh/' + process.env.TWITCH_OAUTH_REFRESH);
  const twitchdata = await twitchrefresh.json();
  process.env.TWITCH_OAUTH_TOKEN = twitchdata.token ?? twitchdata.access_token;
  console.log('Refreshed Twitch OAuth Token');
  console.log('Twitch OAuth Token:', process.env.TWITCH_OAUTH_TOKEN);

  // Configuration for the Twitch bot
  const config = {
    options: {
      debug: process.env.DEBUG === 'true',
    },
    connection: {
      reconnect: true,
      secure: true,
    },
    identity: {
      username: process.env.TWITCH_USERNAME,
      password: process.env.TWITCH_OAUTH_TOKEN,
    },
    channels: process.env.TWITCH_CHANNELS ? process.env.TWITCH_CHANNELS.split(',') : [],
  };

  // Create a client with the configuration
  const client = new tmi.Client(config);

  // Event handlers
  client.on('connected', (address, port) => {
    console.log(`Connected to ${address}:${port}`);
    console.log(`Joining channels: ${config.channels.join(', ')}`);
  });

  client.on('disconnected', (reason) => {
    console.log(`Disconnected: ${reason}`);
  });

  const knownBots = ['nightbot', 'streamelements', 'moobot', 'ba99bot', 'kofistreambot'];

  client.on('message', (channel, tags, message, self) => {
    // Ignore messages from the bot itself
    if (self) return;

    const isReplyToBot = (tags['reply-parent-user-login'] || '').toLowerCase() === (process.env.TWITCH_USERNAME || '').toLowerCase();

    // Log all messages
    console.log(`[${channel}] ${tags.username}: ${message}`);

    // Direct reply to the bot should act like a follow-up question.
    if (isReplyToBot && !message.startsWith('!')) {
      handleCommand(channel, tags, `!ask ${message}`);
      return;
    }

    // Command handler
    if (message.startsWith('!')) {
      handleCommand(channel, tags, message);
    } else {
      if (!knownBots.includes(tags.username.toLowerCase())) {
        handleMessage(channel, tags, message);
      }
    }
  });

  // Command handler function
  async function handleCommand(channel, tags, message) {
    const args = message.slice(1).split(' ');
    const command = args[0].toLowerCase();
    const containsEmote = messageContainsEmote(message);
    const replyTargetId = tags['reply-parent-msg-id'] || tags.id;

    switch (command) {

      case 'commands':
      case 'help':
        client.say(channel, 'Available commands: !ask, !askai, !uptime, !testcheckuserfollow, !testdelmes, !commands');
        break;

      case 'uptime':
        const uptime = process.uptime();
        const hours = Math.floor(uptime / 3600);
        const minutes = Math.floor((uptime % 3600) / 60);
        const seconds = Math.floor(uptime % 60);
        client.say(channel, `Bot uptime: ${hours}h ${minutes}m ${seconds}s ⏰`);
        break;

      case 'testcheckuserfollow':
        try {
          const userId = await getTwitchUserId('ba99bot');
          if (!userId) {
            client.reply(channel, 'ไม่พบผู้ใช้ ba99bot', replyTargetId);
            break;
          }

          const isFollower = await userFollowsChannel({
            ...tags,
            'user-id': userId,
          });
          client.reply(channel, `ba99bot ${isFollower ? 'ติดตาม' : 'ไม่ได้ติดตาม'} ช่องนี้`, replyTargetId);
        } catch (error) {
          console.error('Failed to check ba99bot follower status:', error);
          client.reply(channel, 'ตรวจสอบสถานะผู้ติดตามไม่สำเร็จ', replyTargetId);
        }
        break;

      case 'ask':
      case 'askai':

        if (message.replace('!askai', '').trim().length != 0 || message.replace('!ask', '').trim().length != 0) {
          if (process.env.mode === 'ninerouter') {
            const openai = new OpenAI({
              baseURL: NINEROUTER_ENDPOINT,
              apiKey: process.env.NINEROUTER_API_KEY,
            });

            const stream = await openai.chat.completions.create({
              model: 'foranswerbasicquestions',
              messages: [
                { role: 'system', content: 'คุณเป็น AI assistant ตอบสั้น กระชับ ตอบแค่ 1 บรรทัด ห้ามใช้ markdown ห้ามใช้ ** ห้ามขึ้นหลายบรรทัด' },
                { role: 'user', content: message.replace('!askai', '').replace('!ask', '').trim() }
              ],
              stream: true,
            });

            let fullMessage = '';

            // Collect each chunk into one variable
            for await (const chunk of stream) {
              // process.stdout.write(chunk.choices[0]?.delta?.content || '');
              fullMessage += chunk.choices[0]?.delta?.content || '';
            }

            // Send to chat ONLY after streaming completes
            client.reply(channel, `${fullMessage}`, replyTargetId);
          } else {
            const raw = JSON.stringify({
              "model": "gemma3ne2b-fortwitchchat",
              "messages": [
                {
                  "role": "user",
                  "content": message.replace('!askai', '').replace('!ask', '').trim()
                }
              ]
            });

            const requestOptions = {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
                "Authorization": "Bearer " + process.env.LOCALLLM_API_KEY
              },
              body: raw,
              redirect: "manual",
              signal: AbortSignal.timeout(30 * 60 * 1000)
            };

            queuedFetch(LLM_ENDPOINT, requestOptions)
              .then((response) => response.text())
              .then((result) => {
                const res = JSON.parse(result);
                // console.log(res);
                const aiResponse = res.choices[0].message.content;
                client.reply(channel, `${aiResponse}`, replyTargetId);
              })
              .catch((error) => console.error(error));
          }
          break;
        } else {
          client.reply(channel, `กรุณาใส่ข้อความหลังคำสั่ง !ask ด้วยครับ`, replyTargetId);
          break;
        }

      case 'testdelmes':
        if (message.replace('!testdelmes', '').trim().length != 0) {
          try {
            if (process.env.mode === 'jev') {
              raw = JSON.stringify({
                "model": "oc/jev-1.13-free",
                "state": message.replace('!testdelmes', '').trim(),
                "questions": {
                  "is_urgent": {
                      "type": "noul",
                      "instructions": "Does this message is a scam or promotion or advertising message?"
                  }
                }
              });

              requestOptions = {
                method: "POST",
                headers: {
                  "Content-Type": "application/json",
                  "Authorization": "Bearer " + process.env.NINEROUTER_API_KEY
                },
                body: raw,
                redirect: "manual",
                signal: AbortSignal.timeout(30 * 60 * 1000)
              };

              let fetchllm = await queuedFetch('http://192.168.31.220:20128/v1/systemone', requestOptions);
              let result = await fetchllm.text();
              let res = JSON.parse(result);
              // console.log(res);
              console.log(res);
              const aiResponse = res.answers.is_urgent.noul;

              if (!containsEmote && parseFloat(aiResponse) > 0.5) {
                //remove scam message
                client.reply(channel, 'ข้อความนี้เป็นข้อความสแปม', tags.id);
                // client.timeout(channel, tags.username, 1, 'Scam message detected').catch((err) => console.error(err));
                let removeapioptions = {
                  method: 'DELETE',
                  headers: {
                    'Client-ID': TWITCH_CLIENT_ID,
                    'Authorization': 'Bearer ' + process.env.TWITCH_OAUTH_TOKEN
                  }
                };

                try {
                  const deleteResponse = await fetch(`https://api.twitch.tv/helix/moderation/chat?broadcaster_id=${tags['room-id']}&moderator_id=1414739525&message_id=${tags.id}`, removeapioptions);
                  if (deleteResponse.ok) {
                    console.log(`Deleted message from ${tags.username} for scam content.`);
                  } else {
                    console.error(`Failed to delete message: ${deleteResponse.statusText}`);
                  }
                } catch (error) {
                  console.error(`Error deleting message: ${error}`);
                }
              } else {
                client.reply(channel, 'ข้อความนี้ไม่ใช่ข้อความสแปม', tags.id);
              }
            } else if (process.env.mode === 'ninerouter') {
              const openai = new OpenAI({
                baseURL: NINEROUTER_ENDPOINT,
                apiKey: process.env.NINEROUTER_API_KEY,
              });

              const stream = await openai.chat.completions.create({
                model: 'qwen3-combo',
                messages: [
                  { role: 'user', content: "\"" + message.replace('!testdelmes', '').trim() + "\" is that scam or promotion or advertising message? Answer me just yes or no." }
                ],
                stream: true,
              });

              let aiResponse = '';

              // Collect each chunk into one variable
              for await (const chunk of stream) {
                // process.stdout.write(chunk.choices[0]?.delta?.content || '');
                aiResponse += chunk.choices[0]?.delta?.content || '';
              }

              //console.log thinking
              console.log(stream);

              const streamtwo = await openai.chat.completions.create({
                model: 'granite4-combo',
                messages: [
                  { role: 'user', content: "\"" + message.replace('!testdelmes', '').trim() + "\" is that scam or promotion or advertising message? Answer me just yes or no." }
                ],
                stream: true,
              });

              let aiResponsetwo = '';

              // Collect each chunk into one variable
              for await (const chunk of streamtwo) {
                // process.stdout.write(chunk.choices[0]?.delta?.content || '');
                aiResponsetwo += chunk.choices[0]?.delta?.content || '';
              }

              //console.log thinking
              console.log(streamtwo);

              if (!containsEmote && aiResponse.toLowerCase().includes('yes') && aiResponsetwo.toLowerCase().includes('yes')) {
                //remove scam message
                client.reply(channel, 'ข้อความนี้เป็นข้อความสแปม', tags.id);
                // client.timeout(channel, tags.username, 1, 'Scam message detected').catch((err) => console.error(err));
                let removeapioptions = {
                  method: 'DELETE',
                  headers: {
                    'Client-ID': TWITCH_CLIENT_ID,
                    'Authorization': 'Bearer ' + process.env.TWITCH_OAUTH_TOKEN
                  }
                };

                try {
                  const deleteResponse = await fetch(`https://api.twitch.tv/helix/moderation/chat?broadcaster_id=${tags['room-id']}&moderator_id=1414739525&message_id=${tags.id}`, removeapioptions);
                  if (deleteResponse.ok) {
                    console.log(`Deleted message from ${tags.username} for scam content.`);
                  } else {
                    console.error(`Failed to delete message: ${deleteResponse.statusText}`);
                  }
                } catch (error) {
                  console.error(`Error deleting message: ${error}`);
                }
              } else {
                client.reply(channel, 'ข้อความนี้ไม่ใช่ข้อความสแปม', tags.id);
              }
            } else {
              let raw = JSON.stringify({
                "model": "qwen3:8b",
                "messages": [
                  {
                    "role": "user",
                    "content": "\"" + message.replace('!testdelmes', '').trim() + "\" is that scam or promotion or advertising message? Answer me just yes or no."
                  }
                ]
              });

              let requestOptions = {
                method: "POST",
                headers: {
                  "Content-Type": "application/json",
                  "Authorization": "Bearer " + process.env.LOCALLLM_API_KEY
                },
                body: raw,
                redirect: "manual",
                signal: AbortSignal.timeout(30 * 60 * 1000)
              };
              const response = await queuedFetch(LLM_ENDPOINT, requestOptions);
              const result = await response.text();
              const res = JSON.parse(result);
              // console.log(res);
              console.log(res.choices[0].message);
              const aiResponse = res.choices[0].message.content;

              raw = JSON.stringify({
                "model": "granite4:3b",
                "messages": [
                  {
                    "role": "user",
                    "content": "\"" + message.replace('!testdelmes', '').trim() + "\" is that scam or promotion or advertising message? Answer me just yes or no."
                  }
                ]
              });

              requestOptions = {
                method: "POST",
                headers: {
                  "Content-Type": "application/json",
                  "Authorization": "Bearer " + process.env.LOCALLLM_API_KEY
                },
                body: raw,
                redirect: "manual",
                signal: AbortSignal.timeout(30 * 60 * 1000)
              };

              const responsetwo = await queuedFetch(LLM_ENDPOINT, requestOptions);
              const resulttwo = await responsetwo.text();
              const restwo = JSON.parse(resulttwo);
              console.log(restwo.choices[0].message);
              const aiResponsetwo = restwo.choices[0].message.content;

              if (!containsEmote && aiResponse.toLowerCase().includes('yes') && aiResponsetwo.toLowerCase().includes('yes')) {
                //remove scam message
                client.reply(channel, 'ข้อความนี้เป็นข้อความสแปม', tags.id);
                // client.timeout(channel, tags.username, 1, 'Scam message detected').catch((err) => console.error(err));
                let removeapioptions = {
                  method: 'DELETE',
                  headers: {
                    'Client-ID': TWITCH_CLIENT_ID,
                    'Authorization': 'Bearer ' + process.env.TWITCH_OAUTH_TOKEN
                  }
                };

                try {
                  const deleteResponse = await fetch(`https://api.twitch.tv/helix/moderation/chat?broadcaster_id=${tags['room-id']}&moderator_id=1414739525&message_id=${tags.id}`, removeapioptions);
                  if (deleteResponse.ok) {
                    console.log(`Deleted message from ${tags.username} for scam content.`);
                  } else {
                    console.error(`Failed to delete message: ${deleteResponse.statusText}`);
                  }
                } catch (error) {
                  console.error(`Error deleting message: ${error}`);
                }
              } else {
                client.reply(channel, 'ข้อความนี้ไม่ใช่ข้อความสแปม', tags.id);
              }
            }
          } catch (error) {
            console.error(error);
          }
        } else {
          let removeapioptions = {
            method: 'DELETE',
            headers: {
              'Client-ID': TWITCH_CLIENT_ID,
              'Authorization': 'Bearer ' + process.env.TWITCH_OAUTH_TOKEN
            }
          };

          console.log(tags);

          fetch(`https://api.twitch.tv/helix/moderation/chat?broadcaster_id=${tags['room-id']}&moderator_id=1414739525&message_id=${tags.id}`, removeapioptions)
            .then(response => {
              if (response.ok) {
                console.log(`Deleted message from ${tags.username} for scam content.`);
              } else {
                console.error(`Failed to delete message: ${response.statusText}`);
              }
            })
            .catch(error => console.error(`Error deleting message: ${error}`));
        }
        break;

      default:
        // Unknown command - you can choose to respond or ignore
        break;
    }
  }

  async function handleMessage(channel, tags, message) {
    const containsEmote = messageContainsEmote(message);
    const replyTargetId = tags['reply-parent-msg-id'] || tags.id;

    let raw = JSON.stringify({
      "model": "gemma3n:e2b",
      "messages": [
        {
          "role": "user",
          "content": "\"" + message + "\" is that question message? Answer me just yes or no."
        }
      ]
    });

    let requestOptions = {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": "Bearer " + process.env.LOCALLLM_API_KEY
      },
      body: raw,
      redirect: "manual",
      signal: AbortSignal.timeout(30 * 60 * 1000)
    };

    let isQuestion = false;
    if (process.env.mode === 'jev') {
      raw = JSON.stringify({
        "model": "oc/jev-1.13-free",
        // "messages": [
        //   {
        //     "role": "user",
        //     "content": "\"" + message + "\" is that question message? Answer me just yes or no."
        //   }
        // ]
        "state": message,
        "questions": {
          "is_urgent": {
              "type": "noul",
              "instructions": "Does this message is a question message?"
          }
        }
      });

      requestOptions = {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": "Bearer " + process.env.NINEROUTER_API_KEY
        },
        body: raw,
        redirect: "manual",
        signal: AbortSignal.timeout(30 * 60 * 1000)
      };

      let fetchllm = await queuedFetch('http://192.168.31.220:20128/v1/systemone', requestOptions);
      let result = await fetchllm.text();
      let res = JSON.parse(result);
      // console.log(res);
      console.log(res);
      const aiResponse = res.answers.is_urgent.noul;

      if (parseFloat(aiResponse) > 0.5) {
        isQuestion = true;
      }
    } else {
      if (process.env.mode === 'ninerouter') {
        const openai = new OpenAI({
          baseURL: NINEROUTER_ENDPOINT,
          apiKey: process.env.NINEROUTER_API_KEY,
        });

        const stream = await openai.chat.completions.create({
          model: 'gemma-combo',
          messages: [
            { role: 'system', content: 'Answer me just yes or no.' },
            { role: 'user', content: "\"" + message + "\" is that question message?" }
          ],
          stream: true,
        });

        let aiResponse = '';

        // Collect each chunk into one variable
        for await (const chunk of stream) {
          // process.stdout.write(chunk.choices[0]?.delta?.content || '');
          aiResponse += chunk.choices[0]?.delta?.content || '';
        }

        console.log(aiResponse);
        if (aiResponse.toLowerCase().includes('yes')) {
          isQuestion = true;
        }
      } else {
        let fetchllm = await queuedFetch(LLM_ENDPOINT, requestOptions);
        let result = await fetchllm.text();
        let res = JSON.parse(result);
        // console.log(res);
        console.log(res.choices[0].message);
        const aiResponse = res.choices[0].message.content;

        if (aiResponse.toLowerCase().includes('yes')) {
          isQuestion = true;
        }
      }
    }

    if (!isQuestion && !(await userFollowsChannel(tags))) {
      
      raw = JSON.stringify({
        "model": "qwen3:8b",
        "messages": [
          {
            "role": "user",
            "content": "\"" + message + "\" is that scam or promotion or advertising message from twitch chat? Answer me just yes or no."
          }
        ]
      });

      requestOptions = {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": "Bearer " + process.env.LOCALLLM_API_KEY
        },
        body: raw,
        redirect: "manual",
        signal: AbortSignal.timeout(30 * 60 * 1000)
      };

      if (message.length > 15) {
        try {
          let aiResponse = '';

          if (process.env.mode === 'ninerouter') {
            const openai = new OpenAI({
              baseURL: NINEROUTER_ENDPOINT,
              apiKey: process.env.NINEROUTER_API_KEY,
            });

            const stream = await openai.chat.completions.create({
              model: 'qwen3-combo',
              messages: [
                { role: 'system', content: 'Answer me just yes or no.' },
                { role: 'user', content: "\"" + message + "\" is that scam or promotion or advertising message from twitch chat?" }
              ],
              stream: true,
            });

            // Collect each chunk into one variable
            for await (const chunk of stream) {
              // process.stdout.write(chunk.choices[0]?.delta?.content || '');
              aiResponse += chunk.choices[0]?.delta?.content || '';
            }
            console.log(aiResponse);
          } else {
            const response = await queuedFetch(LLM_ENDPOINT, requestOptions);
            const result = await response.text();
            const res = JSON.parse(result);
            // console.log(res);
            console.log(res.choices[0].message);
            aiResponse = res.choices[0].message.content;
          }

          let aiResponsetwo = '';

          if (process.env.mode === 'ninerouter') {
            const openai = new OpenAI({
              baseURL: NINEROUTER_ENDPOINT,
              apiKey: process.env.NINEROUTER_API_KEY,
            });

            const streamtwo = await openai.chat.completions.create({
              model: 'gemma-combo',
              messages: [
                { role: 'system', content: 'Answer me just yes or no.' },
                { role: 'user', content: "\"" + message + "\" is that scam or promotion or advertising message from twitch chat?" }
              ],
              stream: true,
            });

            for await (const chunk of streamtwo) {
              aiResponsetwo += chunk.choices[0]?.delta?.content || '';
            }

            console.log(aiResponsetwo);
          } else {
            raw = JSON.stringify({
              "model": "gemma4:12b",
              "messages": [
                {
                  "role": "user",
                  "content": "\"" + message + "\" is that scam or promotion or advertising message from twitch chat? Answer me just yes or no."
                }
              ]
            });

            requestOptions = {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
                "Authorization": "Bearer " + process.env.LOCALLLM_API_KEY
              },
              body: raw,
              redirect: "manual",
              signal: AbortSignal.timeout(30 * 60 * 1000)
            };

            const responsetwo = await queuedFetch(LLM_ENDPOINT, requestOptions);
            const resulttwo = await responsetwo.text();
            const restwo = JSON.parse(resulttwo);
            console.log(restwo.choices[0].message);
            aiResponsetwo = restwo.choices[0].message.content;
          }

          if (!containsEmote && aiResponse.toLowerCase().includes('yes') && aiResponsetwo.toLowerCase().includes('yes')) {
            isQuestion = false;
            //remove scam message
            // client.timeout(channel, tags.username, 1, 'Scam message detected').catch((err) => console.error(err));
            let removeapioptions = {
              method: 'DELETE',
              headers: {
                'Client-ID': TWITCH_CLIENT_ID,
                'Authorization': 'Bearer ' + process.env.TWITCH_OAUTH_TOKEN
              }
            };

            try {
              const deleteResponse = await fetch(`https://api.twitch.tv/helix/moderation/chat?broadcaster_id=${tags['room-id']}&moderator_id=1414739525&message_id=${tags.id}`, removeapioptions);
              if (deleteResponse.ok) {
                console.log(`Deleted message from ${tags.username} for scam content.`);
              } else {
                console.error(`Failed to delete message: ${deleteResponse.statusText}`);
              }
            } catch (error) {
              console.error(`Error deleting message: ${error}`);
            }
          }
        } catch (error) {
          console.error(error);
        }
      }
    }

    if (isQuestion) {
      raw = JSON.stringify({
        "model": "glm-4.7-flash:latest",
        "messages": [
          {
            "role": "user",
            "content": "\"" + message + "\" from the above message, is it a message that wants to play a game with me? Answer just yes or no."
          }
        ]
      });

      requestOptions = {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": "Bearer " + process.env.LOCALLLM_API_KEY
        },
        body: raw,
        redirect: "manual",
        signal: AbortSignal.timeout(30 * 60 * 1000)
      };

      try {
        let aiResponse = '';

        if (process.env.mode === 'ninerouter') {
          const openai = new OpenAI({
            baseURL: NINEROUTER_ENDPOINT,
            apiKey: process.env.NINEROUTER_API_KEY,
          });

          const stream = await openai.chat.completions.create({
            model: 'glm-combo',
            messages: [
              { 
                role: 'system', 
                content: 'Answer me just yes or no.' 
              },
              {
                role: 'user',
                content: `"${message}", from the message is it a message that wants to play a game with me?`
              }
            ],
            stream: true,
          });

          for await (const chunk of stream) {
            aiResponse += chunk.choices[0]?.delta?.content || '';
          }
        } else {
          const response = await queuedFetch(LLM_ENDPOINT, requestOptions);
          const result = await response.text();
          const res = JSON.parse(result);
          console.log(res.choices[0].message);
          aiResponse = res.choices[0].message.content;
        }

        if (aiResponse.toLowerCase().includes('yes')) {
          client.reply(channel, 'https://discord.gg/6RJ99Fw8SR', replyTargetId);
        }
      } catch (error) {
        console.error(error);
      }
    }
  }

  // Error handler
  client.on('error', (err) => {
    console.error('Error:', err);
  });

  // Connect to Twitch
  client.connect().catch(console.error);

  // Start hourly fun facts
  // setInterval(() => {
  //   sendGameFunFact(client, config.channels);
  // }, 60 * 60 * 1000);

  // Graceful shutdown
  process.on('SIGINT', () => {
    console.log('\nShutting down bot...');
    client.disconnect();
    process.exit(0);
  });

  client.on('join', (channel, username, self) => {
    if (!dontshow.includes(username)) {
      viewerlist.push(username);
    }
  });

  client.on('part', (channel, username, self) => {
    viewerlist = viewerlist.filter(user => user !== username);
  });
})();

fastify.get('/viewers', async (request, reply) => {
  reply
    .code(200)
    .header('Access-Control-Allow-Origin', '*')
    .header('Cache-Control', 'no-cache, no-store, must-revalidate')
    .header('Refresh', '30')
    .send(viewerlist);
});

fastify.get('/viewerslist', async (request, reply) => {
  return reply.sendFile('viewerslist.html');
});

// Run the server!
fastify.listen({ port: process.env.PORT || 3000, host: '0.0.0.0' }, (err) => {
  if (err) {
    fastify.log.error(err)
    process.exit(1)
  }
})
