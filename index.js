require('dotenv').config();
const tmi = require('tmi.js');
const fastify = require('fastify')({ logger: false });
const path = require('path');
const { Agent, setGlobalDispatcher } = require('undici');

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

// Drop-in replacement for fetch() against the LLM endpoint: same signature,
// same return value (a Promise<Response>), but serialized through llmQueue.
function queuedFetch(url, options) {
  return llmQueue.enqueue(() => fetch(url, options));
}

let viewerlist = [];
const dontshow = ['nightbot', 'streamelements', 'moobot', 'trackerggbot', 'boyalone99', process.env.TWITCH_USERNAME];

(async () => {
  const twitchrefresh = await fetch('https://twitchtokengenerator.com/api/refresh/'+process.env.TWITCH_OAUTH_REFRESH);
  const twitchdata = await twitchrefresh.json();
  process.env.TWITCH_OAUTH_TOKEN = twitchdata.token ?? twitchdata.access_token;
  console.log('Refreshed Twitch OAuth Token');

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

  const knownBots = ['nightbot', 'streamelements', 'moobot', 'ba99bot'];

  client.on('message', (channel, tags, message, self) => {
    // Ignore messages from the bot itself
    if (self) return;

    // Log all messages
    console.log(`[${channel}] ${tags.username}: ${message}`);

    // Command handler
    if (message.startsWith('!')) {
      handleCommand(channel, tags, message);
    } else {
      if(!knownBots.includes(tags.username.toLowerCase())) {
        handleMessage(channel, tags, message);
      }
    }
  });

  // Command handler function
  async function handleCommand(channel, tags, message) {
    const args = message.slice(1).split(' ');
    const command = args[0].toLowerCase();

    switch (command) {

      case 'commands':
      case 'help':
        client.say(channel, 'Available commands: !ask, !askai, !uptime, !commands');
        break;

      case 'uptime':
        const uptime = process.uptime();
        const hours = Math.floor(uptime / 3600);
        const minutes = Math.floor((uptime % 3600) / 60);
        const seconds = Math.floor(uptime % 60);
        client.say(channel, `Bot uptime: ${hours}h ${minutes}m ${seconds}s ⏰`);
        break;

      case 'ask':
      case 'askai':

        if(message.replace('!askai', '').trim().length != 0 || message.replace('!ask', '').trim().length != 0) {
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
              client.reply(channel, `${aiResponse}`, tags.id);
            })
            .catch((error) => console.error(error));
          break;
        } else {
          client.reply(channel, `กรุณาใส่ข้อความหลังคำสั่ง !ask ด้วยครับ`, tags.id);
          break;
        }

      case 'testdelmes':
        if (message.replace('!testdelmes', '').trim().length != 0) {
          try {
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

            if(aiResponse.toLowerCase().includes('yes') && aiResponsetwo.toLowerCase().includes('yes')){
              //remove scam message
              client.reply(channel, 'ข้อความนี้เป็นข้อความสแปม', tags.id);
              // client.timeout(channel, tags.username, 1, 'Scam message detected').catch((err) => console.error(err));
              let removeapioptions = {
                method: 'DELETE',
                headers: {
                  'Client-ID': 'gp762nuuoqcoxypju8c569th9wz7q5',
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
          } catch (error) {
            console.error(error);
          }
        } else {
          let removeapioptions = {
            method: 'DELETE',
            headers: {
              'Client-ID': 'gp762nuuoqcoxypju8c569th9wz7q5',
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
    let fetchllm = await queuedFetch(LLM_ENDPOINT, requestOptions);
    let result = await fetchllm.text();
    let res = JSON.parse(result);
    // console.log(res);
    console.log(res.choices[0].message);
    const aiResponse = res.choices[0].message.content;
    if(aiResponse.toLowerCase().includes('yes')){
      isQuestion = true;
    }

    if (!isQuestion) {
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

      if(message.length > 15) {
        try {
          const response = await queuedFetch(LLM_ENDPOINT, requestOptions);
          const result = await response.text();
          const res = JSON.parse(result);
          // console.log(res);
          console.log(res.choices[0].message);
          const aiResponse = res.choices[0].message.content;

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
          const aiResponsetwo = restwo.choices[0].message.content;

          if(aiResponse.toLowerCase().includes('yes') && aiResponsetwo.toLowerCase().includes('yes')){
              //remove scam message
              // client.timeout(channel, tags.username, 1, 'Scam message detected').catch((err) => console.error(err));
              let removeapioptions = {
                method: 'DELETE',
                headers: {
                  'Client-ID': 'gp762nuuoqcoxypju8c569th9wz7q5',
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

    raw = JSON.stringify({
      "model": "qwen3.5:9b",
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
      const response = await queuedFetch(LLM_ENDPOINT, requestOptions);
      const result = await response.text();
        const res = JSON.parse(result);
        // console.log(res);
        console.log(res.choices[0].message);
        const aiResponse = res.choices[0].message.content;
        if(aiResponse.toLowerCase().includes('yes')){
          client.reply(channel, 'https://discord.gg/6HJ2C99cqR', tags.id);
        }
    } catch (error) {
      console.error(error);
    }
  }

  // Error handler
  client.on('error', (err) => {
    console.error('Error:', err);
  });

  // Connect to Twitch
  client.connect().catch(console.error);

  // Graceful shutdown
  process.on('SIGINT', () => {
    console.log('\nShutting down bot...');
    client.disconnect();
    process.exit(0);
  });

  client.on('join', (channel, username, self) => {
    if(!dontshow.includes(username)) {
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
fastify.listen({ port: process.env.PORT || 3000 , host: '0.0.0.0' }, (err) => {
  if (err) {
    fastify.log.error(err)
    process.exit(1)
  }
})
