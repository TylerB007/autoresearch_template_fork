/**
 * Optional notification system — Telegram and Discord webhook alerts
 * Notification failures never crash the bot (fire-and-forget with error logging)
 */

import type { AppConfig, NotificationCategory } from './types.js';
import logger from './logger.js';

export async function sendNotification(
  message: string,
  config: AppConfig,
  level: 'info' | 'critical' = 'info',
  category?: NotificationCategory,
  silent?: boolean,
): Promise<void> {
  if (!config.notifications.enabled) return;

  // Check notification preferences — category is suppressed only if explicitly set to false
  if (category && config.notifications.preferences) {
    const pref = config.notifications.preferences[category];
    if (pref === false) return;
  }

  const promises: Promise<void>[] = [];

  if (config.notifications.telegram_bot_token && config.notifications.telegram_chat_id) {
    promises.push(
      sendTelegram(
        message,
        config.notifications.telegram_bot_token,
        config.notifications.telegram_chat_id,
        silent,
      ),
    );
  }

  if (config.notifications.discord_webhook_url) {
    const title = `${config.chain.protocolName} Rebalancer ${level === 'critical' ? 'ALERT' : 'Notification'}`;
    promises.push(sendDiscord(message, config.notifications.discord_webhook_url, level, title));
  }

  await Promise.allSettled(promises);
}

async function sendTelegram(
  message: string,
  botToken: string,
  chatId: string,
  silent?: boolean,
): Promise<void> {
  try {
    const url = `https://api.telegram.org/bot${botToken}/sendMessage`;
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        text: message,
        parse_mode: 'Markdown',
        disable_notification: silent === true,
      }),
    });
    if (!response.ok) {
      logger.warn(`Telegram notification failed: ${response.status} ${response.statusText}`);
    }
  } catch (error) {
    logger.warn(`Telegram notification error: ${error}`);
  }
}

async function sendDiscord(
  message: string,
  webhookUrl: string,
  level: string,
  title: string,
): Promise<void> {
  try {
    const color = level === 'critical' ? 0xff0000 : 0x00ff00;
    const response = await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        embeds: [
          {
            title,
            description: message,
            color,
            timestamp: new Date().toISOString(),
          },
        ],
      }),
    });
    if (!response.ok) {
      logger.warn(`Discord notification failed: ${response.status} ${response.statusText}`);
    }
  } catch (error) {
    logger.warn(`Discord notification error: ${error}`);
  }
}
