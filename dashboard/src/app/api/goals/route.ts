import { NextRequest } from 'next/server';
import { existsSync, readFileSync } from 'fs';
import { join, dirname } from 'path';
import { randomBytes } from 'crypto';
import { getGoals } from '@/lib/data/goals';
import { getGoalsPath } from '@/lib/config';

export const dynamic = 'force-dynamic';

const ORG_REGEX = /^[a-z0-9_-]+$/;

/**
 * GET /api/goals?org=<org>
 * Returns { north_star, daily_focus, bottleneck, goals, updated_at } for the given org.
 */
export async function GET(request: NextRequest) {
  const { searchParams } = request.nextUrl;
  const org = searchParams.get('org') || 'default';

  if (!ORG_REGEX.test(org)) {
    return Response.json({ error: 'Invalid org' }, { status: 400 });
  }

  // Read full goals.json so we include north_star and daily_focus
  const goalsPath = getGoalsPath(org);
  let raw: Record<string, unknown> = {};
  if (existsSync(goalsPath)) {
    try {
      raw = JSON.parse(readFileSync(goalsPath, 'utf-8'));
    } catch { /* fall through to defaults */ }
  }

  const data = getGoals(org);
  return Response.json({
    ...data,
    north_star: typeof raw.north_star === 'string' ? raw.north_star : '',
    daily_focus: typeof raw.daily_focus === 'string' ? raw.daily_focus : '',
    daily_focus_set_at: typeof raw.daily_focus_set_at === 'string' ? raw.daily_focus_set_at : '',
    updated_at: typeof raw.updated_at === 'string' ? raw.updated_at : '',
  });
}

/**
 * PATCH /api/goals?org=<org>
 * Updates north_star, daily_focus, bottleneck, and/or goals in goals.json.
 * Body: { north_star?, daily_focus?, bottleneck?, goals? }
 */
export async function PATCH(request: NextRequest) {
  const { searchParams } = request.nextUrl;
  const org = searchParams.get('org') || '';

  if (!org || !ORG_REGEX.test(org)) {
    return Response.json({ error: 'Invalid or missing org' }, { status: 400 });
  }

  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  // Read existing file
  const goalsPath = getGoalsPath(org);
  let current: Record<string, unknown> = {
    north_star: '',
    daily_focus: '',
    daily_focus_set_at: '',
    goals: [],
    bottleneck: '',
    updated_at: '',
  };
  if (existsSync(goalsPath)) {
    try {
      current = JSON.parse(readFileSync(goalsPath, 'utf-8'));
    } catch { /* use defaults */ }
  }

  // Apply updates
  if (body.north_star !== undefined) {
    if (typeof body.north_star !== 'string') {
      return Response.json({ error: 'north_star must be a string' }, { status: 400 });
    }
    current.north_star = body.north_star;
  }
  if (body.daily_focus !== undefined) {
    if (typeof body.daily_focus !== 'string') {
      return Response.json({ error: 'daily_focus must be a string' }, { status: 400 });
    }
    current.daily_focus = body.daily_focus;
    current.daily_focus_set_at = new Date().toISOString();
  }
  if (body.bottleneck !== undefined) {
    if (typeof body.bottleneck !== 'string') {
      return Response.json({ error: 'bottleneck must be a string' }, { status: 400 });
    }
    current.bottleneck = body.bottleneck;
  }
  if (body.goals !== undefined) {
    if (!Array.isArray(body.goals)) {
      return Response.json({ error: 'goals must be an array' }, { status: 400 });
    }
    current.goals = body.goals;
  }

  current.updated_at = new Date().toISOString();

  // Atomic write (tmp + rename preserves other processes' reads)
  try {
    const { writeFileSync, renameSync, unlinkSync, mkdirSync } = await import('fs');
    // getGoalsPath falls back to a state path that may never have been created —
    // `org` only has to match /^[a-z0-9_-]+$/, so a new org name is enough to
    // land here. The shared writer in lib/data/goals.ts creates it too.
    mkdirSync(dirname(goalsPath), { recursive: true });
    // The temp file MUST live in the target's own directory. rename(2) fails
    // with EXDEV across filesystems, and the system temp dir is a separate mount
    // whenever /tmp is tmpfs, or under Docker / systemd PrivateTmp.
    const tmp = join(dirname(goalsPath), `.tmp.goals-${randomBytes(6).toString('hex')}`);
    try {
      writeFileSync(tmp, JSON.stringify(current, null, 2) + '\n', 'utf-8');
      renameSync(tmp, goalsPath);
    } catch (err) {
      try { unlinkSync(tmp); } catch { /* ignore cleanup errors */ }
      throw err;
    }
  } catch {
    return Response.json({ error: 'Failed to write goals.json' }, { status: 500 });
  }

  return Response.json({
    success: true,
    north_star: current.north_star,
    daily_focus: current.daily_focus,
    daily_focus_set_at: current.daily_focus_set_at,
    bottleneck: current.bottleneck,
    goals: current.goals,
    updated_at: current.updated_at,
  });
}
