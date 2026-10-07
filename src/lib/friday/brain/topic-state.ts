/**
 * FRIDAY · topic state
 *
 * Active topic / subtopic helpers over the one conversation session.
 * Not a second store.
 */

import {
  addSubtopic,
  getConversationSession,
  setActiveTopic,
  type ConversationSession,
} from "./conversation-state";

export function currentTopic(): string {
  return getConversationSession().activeTopic;
}

export function currentSubtopics(): string[] {
  return [...getConversationSession().subtopics];
}

export function noteTopic(topic: string): ConversationSession {
  setActiveTopic(topic);
  return getConversationSession();
}

export function noteSubtopic(topic: string): ConversationSession {
  addSubtopic(topic);
  return getConversationSession();
}

export function topicShift(from: string, toward: string): ConversationSession {
  if (from.trim()) setActiveTopic(from.trim());
  if (toward.trim()) addSubtopic(toward.trim());
  return getConversationSession();
}
