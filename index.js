require('dotenv').config();
const tmi = require('tmi.js');

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

client.on('message', (channel, tags, message, self) => {
  // Ignore messages from the bot itself
  if (self) return;

  // Log all messages
  console.log(`[${channel}] ${tags.username}: ${message}`);

  // Command handler
  if (message.startsWith('!')) {
    handleCommand(channel, tags, message);
  }
});

// Command handler function
function handleCommand(channel, tags, message) {
  const args = message.slice(1).split(' ');
  const command = args[0].toLowerCase();

  switch (command) {
    case 'hello':
    case 'hi':
      client.say(channel, `Hello @${tags.username}! 👋`);
      break;

    case 'commands':
    case 'help':
      client.say(channel, 'Available commands: !hello, !dice, !uptime, !commands');
      break;

    case 'dice':
      const roll = Math.floor(Math.random() * 6) + 1;
      client.say(channel, `@${tags.username} rolled a ${roll}! 🎲`);
      break;

    case 'uptime':
      const uptime = process.uptime();
      const hours = Math.floor(uptime / 3600);
      const minutes = Math.floor((uptime % 3600) / 60);
      const seconds = Math.floor(uptime % 60);
      client.say(channel, `Bot uptime: ${hours}h ${minutes}m ${seconds}s ⏰`);
      break;

    case 'askai':
      // const myHeaders = 
      // myHeaders.append("Authorization", "Bearer " + process.env.LOCALLLM_API_KEY);
      // myHeaders.append("Content-Type", "application/json");

      const raw = JSON.stringify({
        "model": "gemma3:270m",
        "messages": [
          {
            "role": "user",
            "content": message.replace('!askai', '').trim()
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
        redirect: "manual"
      };

      fetch("http://192.168.31.210:3001/api/chat/completions", requestOptions)
        .then((response) => response.text())
        .then((result) => {
          const res = JSON.parse(result);
          const aiResponse = res.choices[0].message.content;
          client.reply(channel, `${aiResponse}`, tags.id);
        })
        .catch((error) => console.error(error));
      // client.reply(channel, `@${tags.username}, AI features are coming soon! 🤖`, tags.id);
      break;

    default:
      // Unknown command - you can choose to respond or ignore
      break;
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
