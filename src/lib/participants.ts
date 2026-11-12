/**
 * @file participants.ts
 * @description Shared participant helpers for the screens.
 */
import { Participant } from '@/types/tab';
import { isSelfParticipant } from '@/lib/ledgerUtils';

export interface WizardParticipant {
  id: string;
  name: string;
  color: string;
  isHost?: boolean;
}

const FALLBACK_COLORS = ['#e09f67', '#10b981', '#f59e0b', '#06b6d4', '#ec4899', '#14b8a6'];

export const toWizardParticipants = (parts: Participant[] | undefined): WizardParticipant[] => {
  const list = parts || [];
  const hasExplicitHost = list.some((p) => p.isHost || isSelfParticipant(p.name));
  return list.map((p, idx) => ({
    id: p.id,
    name: p.name,
    color: p.color || FALLBACK_COLORS[idx % FALLBACK_COLORS.length],
    isHost: p.isHost ?? (isSelfParticipant(p.name) || (!hasExplicitHost && idx === 0)),
  }));
};

export const DEFAULT_PARTICIPANTS: WizardParticipant[] = [
  { id: 'p_me', name: 'Me', color: '#e09f67', isHost: true },
];
