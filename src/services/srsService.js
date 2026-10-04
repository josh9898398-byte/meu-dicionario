/**
 * SRSService — deliberately simple spaced repetition (not a full Anki clone).
 *
 * Levels:  new -> learning -> familiar -> mastered
 * Ratings: again 不认识 · hard 模糊 · good 认识
 *
 * Scheduling rules (documented so they can be tuned later):
 *   again : streak=0, ease-0.2, back in the same session (10 min), level -> learning
 *   hard  : streak stays, ease-0.05, interval *1.2
 *   good  : streak+1, ease+0.05, interval follows the ladder, level up every 2 goods
 */

import { favoriteRepo, learningRepo } from '../db/repos.js';
import { MASTERY_LEVELS } from '../db/schema.js';
import { startOfDay, endOfDay, dayKey } from '../core/format.js';

const MIN_EASE = 1.3;
const MAX_EASE = 2.8;
const AGAIN_DELAY_MS = 10 * 60 * 1000;
const LADDER_DAYS = [1, 3, 7, 16, 35, 75, 150, 300];

export const RATINGS = {
  again: { id: 'again', label: '不认识', tone: 'danger', hint: '重新学习' },
  hard: { id: 'hard', label: '模糊', tone: 'warn', hint: '稍后再看' },
  good: { id: 'good', label: '认识', tone: 'ok', hint: '记住了' }
};

export function schedule(favorite, rating, { now = Date.now() } = {}) {
  const current = {
    ease: favorite.ease ?? 2.5,
    intervalDays: favorite.intervalDays ?? 0,
    streak: favorite.streak ?? 0,
    masteryLevel: favorite.masteryLevel || 'new',
    reviewCount: favorite.reviewCount ?? 0,
    correctCount: favorite.correctCount ?? 0
  };

  let { ease, intervalDays, streak, masteryLevel } = current;
  let nextReviewAt;

  if (rating === 'again') {
    ease = clamp(ease - 0.2);
    streak = 0;
    intervalDays = 0;
    masteryLevel = 'learning';
    nextReviewAt = now + AGAIN_DELAY_MS;
  } else if (rating === 'hard') {
    ease = clamp(ease - 0.05);
    intervalDays = intervalDays ? Math.max(1, Math.round(intervalDays * 1.2)) : 1;
    masteryLevel = advance(masteryLevel, streak, false);
    nextReviewAt = now + intervalDays * 86400000;
  } else {
    ease = clamp(ease + 0.05);
    streak += 1;
    intervalDays = intervalDays
      ? Math.max(1, Math.round(intervalDays * ease))
      : LADDER_DAYS[Math.min(streak - 1, LADDER_DAYS.length - 1)];
    intervalDays = Math.min(intervalDays, 365);
    masteryLevel = advance(masteryLevel, streak, true);
    nextReviewAt = now + intervalDays * 86400000;
  }

  return {
    ...favorite,
    ease,
    intervalDays,
    streak,
    masteryLevel,
    reviewCount: current.reviewCount + 1,
    correctCount: current.correctCount + (rating === 'good' ? 1 : 0),
    lastReviewedAt: now,
    nextReviewAt,
    updatedAt: now
  };
}

function clamp(ease) {
  return Math.min(MAX_EASE, Math.max(MIN_EASE, Number(Number(ease).toFixed(2))));
}

function advance(level, streak, isGood) {
  const order = ['new', 'learning', 'familiar', 'mastered'];
  const index = Math.max(0, order.indexOf(level));
  if (!isGood) return order[Math.max(1, Math.min(index, 2))];
  if (streak >= 8 && order[index] === 'familiar') return 'mastered';
  if (streak >= 2 && index < order.length - 1) return order[index + 1];
  return level === 'new' ? 'learning' : level;
}

/** Persist a review result and its history record. */
export async function review(favoriteId, rating, { durationMs = 0, mode = 'study' } = {}) {
  const favorite = await favoriteRepo.get(favoriteId);
  if (!favorite) throw new Error('未找到该词条');
  const previousLevel = favorite.masteryLevel;
  const updated = schedule(favorite, rating);
  await favoriteRepo.save(updated);
  await learningRepo.add({
    favoriteId,
    rating,
    mode,
    durationMs,
    previousLevel,
    nextLevel: updated.masteryLevel
  });
  return updated;
}

/** mode: 'all' | 'due' | 'new' | 'struggling' */
export async function buildQueue({ limit = 20, mode = 'all', tag = null, type = null } = {}) {
  const all = await favoriteRepo.allSorted();
  const timestamp = Date.now();
  const matches = (fav) => (!tag || (fav.tags || []).includes(tag)) && (!type || fav.type === type);
  const pool = all.filter((f) => !f.archived && matches(f));

  const due = pool
    .filter((f) => (f.nextReviewAt || 0) <= timestamp && (f.reviewCount || 0) > 0)
    .sort((a, b) => (a.nextReviewAt || 0) - (b.nextReviewAt || 0));
  const fresh = pool
    .filter((f) => (f.reviewCount || 0) === 0)
    .sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));
  const struggling = pool
    .filter((f) => (f.streak || 0) === 0 && (f.reviewCount || 0) > 0)
    .sort((a, b) => (a.nextReviewAt || 0) - (b.nextReviewAt || 0));

  let queue;
  if (mode === 'due') queue = due;
  else if (mode === 'new') queue = fresh;
  else if (mode === 'struggling') queue = struggling;
  else {
    const duePart = due.slice(0, Math.ceil(limit * 0.7));
    const newPart = fresh.slice(0, Math.max(0, limit - duePart.length));
    const used = new Set([...duePart, ...newPart].map((f) => f.id));
    const fill = pool.filter((f) => !used.has(f.id));
    queue = [...duePart, ...newPart, ...fill.slice(0, Math.max(0, limit - duePart.length - newPart.length))];
  }
  return queue.slice(0, limit);
}

export async function stats({ now = Date.now() } = {}) {
  const all = await favoriteRepo.all();
  const active = all.filter((f) => !f.archived);
  const byLevel = { new: 0, learning: 0, familiar: 0, mastered: 0 };
  for (const fav of active) byLevel[fav.masteryLevel || 'new'] += 1;

  const records = await learningRepo.all();
  const today = dayKey(now);
  const startToday = startOfDay(now);

  return {
    total: active.length,
    byLevel,
    dueToday: active.filter((f) => (f.nextReviewAt || 0) <= endOfDay(now)).length,
    dueNow: active.filter((f) => (f.nextReviewAt || 0) <= now).length,
    newCount: byLevel.new,
    reviewsToday: records.filter((r) => r.day === today).length,
    reviewsThisWeek: records.filter((r) => r.reviewedAt >= startToday - 6 * 86400000).length,
    totalReviews: records.length,
    accuracy: records.length
      ? Math.round((records.filter((r) => r.rating === 'good').length / records.length) * 100)
      : 0,
    streakDays: computeStreak(records, now),
    levelLabels: MASTERY_LEVELS
  };
}

export function computeStreak(records, now = Date.now()) {
  if (!records?.length) return 0;
  const days = new Set(records.map((r) => r.day));
  let cursor = startOfDay(now);
  if (!days.has(dayKey(cursor))) {
    cursor -= 86400000;
    if (!days.has(dayKey(cursor))) return 0;
  }
  let streak = 0;
  while (days.has(dayKey(cursor))) {
    streak += 1;
    cursor -= 86400000;
  }
  return streak;
}

export async function resetProgress(favoriteId) {
  const favorite = await favoriteRepo.get(favoriteId);
  if (!favorite) return null;
  return favoriteRepo.save({
    ...favorite,
    masteryLevel: 'new',
    ease: 2.5,
    intervalDays: 0,
    streak: 0,
    reviewCount: 0,
    correctCount: 0,
    lastReviewedAt: null,
    nextReviewAt: Date.now()
  });
}

export { LADDER_DAYS, AGAIN_DELAY_MS };

export const srsService = {
  schedule, review, buildQueue, stats, computeStreak, resetProgress, RATINGS
};
