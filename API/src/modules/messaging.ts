/** Private messaging module. */

import { ModuleBase } from './base';

export interface Message {
  _id: string;
  user: string;
  respondent: string;
  date: string;
  type: 'in' | 'out';
  text: string;
  unread?: boolean;
}

export class MessagingModule extends ModuleBase {
  /** Conversation index (latest message per correspondent). @rateLimit default */
  index(): Promise<{ messages: Array<{ _id: string; message: Message }>; users: Record<string, unknown> }> {
    return this.client.call('user/messages/index');
  }

  /** Full message thread with a user. @rateLimit default */
  list(respondent: string): Promise<{ messages: Message[] }> {
    return this.client.call('user/messages/list', { query: { respondent } });
  }

  /** Send a private message to a user (by user id). @rateLimit default */
  send(respondent: string, text: string): Promise<unknown> {
    return this.client.call('user/messages/send', { body: { respondent, text } });
  }

  /** Count of unread messages. @rateLimit default */
  unreadCount(): Promise<{ count: number }> {
    return this.client.call('user/messages/unread-count');
  }

  /** Mark a message as read. @rateLimit default */
  markRead(id: string): Promise<unknown> {
    return this.client.call('user/messages/mark-read', { body: { id } });
  }
}
