/**
 * Helper script to get your Telegram chat ID
 * Run this, then send a message to your bot, and it will show you your chat ID
 */

import TelegramBot from 'node-telegram-bot-api';
import dotenv from 'dotenv';
import { parse as parseYaml } from 'yaml';
import { readFileSync } from 'node:fs';

dotenv.config();

// Load bot token from config.yaml
const configFile = readFileSync('config.yaml', 'utf-8');
const config: any = parseYaml(configFile);

const botToken = config.notifications?.telegram_bot_token;

if (!botToken) {
  console.error('❌ No telegram_bot_token found in config.yaml');
  process.exit(1);
}

console.log('🤖 Starting Telegram bot to get your chat ID...\n');
console.log('📱 Instructions:');
console.log('   1. Open Telegram');
console.log(`   2. Search for @automate9mmBot`);
console.log('   3. Send any message to the bot (e.g., "hello")');
console.log('   4. Your chat ID will appear below\n');
console.log('Waiting for messages...\n');

const bot = new TelegramBot(botToken, { polling: true });

bot.on('message', (msg) => {
  console.log('✅ Message received!');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log(`📋 Your Chat ID: ${msg.chat.id}`);
  console.log(`👤 Username: @${msg.from?.username || 'unknown'}`);
  console.log(`💬 Message: "${msg.text}"`);
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');
  console.log('📝 Update your config.yaml:');
  console.log(`   telegram_chat_id: "${msg.chat.id}"`);
  console.log('\nPress Ctrl+C to exit');
});

bot.on('polling_error', (error) => {
  console.error('❌ Error:', error.message);
  if (error.message.includes('401')) {
    console.error('\n🚨 Invalid bot token! Please check:');
    console.error('   1. Did you create the bot with @BotFather?');
    console.error('   2. Is the token in config.yaml correct?');
    console.error('   3. Try creating a new bot with @BotFather\n');
  }
  process.exit(1);
});

process.on('SIGINT', () => {
  console.log('\n\n👋 Exiting...');
  bot.stopPolling();
  process.exit(0);
});
