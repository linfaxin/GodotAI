import type { CapabilityProfileV1 } from '../contracts';
import { CODEC_DEFINITIONS } from './codecs';
import { CORE_PROFILE, HOST_SCHEMA, type HostSchema } from './core';
import { MEDIA_HOST_SCHEMA, UI_MEDIA_PROFILE } from './media';
import { PHYSICS_HOST_SCHEMA, BEHAVIOR_PHYSICS_PROFILE } from './physics';

/** The additive 2D surface reuses the exact certified definitions of each extension. */
export const GAME_2D_HOST_SCHEMA: Readonly<Record<string, HostSchema>> = Object.freeze({
  ...HOST_SCHEMA, ...MEDIA_HOST_SCHEMA, ...PHYSICS_HOST_SCHEMA,
});
export const GAME_2D_PROFILE: CapabilityProfileV1 = Object.freeze({
  ...CORE_PROFILE,
  id: 'game-2d-v1',
  hosts: Object.freeze(Object.keys(GAME_2D_HOST_SCHEMA)),
  resources: Object.freeze([...new Set([...UI_MEDIA_PROFILE.resources, ...BEHAVIOR_PHYSICS_PROFILE.resources])]),
  features: Object.freeze({ ...CORE_PROFILE.features, media: true, physics: true }),
});
export const GAME_2D_SCHEMA_DESCRIPTOR = Object.freeze({ profile: GAME_2D_PROFILE, hosts: GAME_2D_HOST_SCHEMA, codecs: CODEC_DEFINITIONS });
/** SHA-256 of canonicalJson(GAME_2D_SCHEMA_DESCRIPTOR); conformance tests verify it. */
export const GAME_2D_PROFILE_HASH = '79dc93cfef5ef5cddf1c2a2026c83e0daf7862cfd72f3557d7e557f13f551a01';
export const game2dProfileReference = () => Object.freeze({ id: GAME_2D_PROFILE.id, version: GAME_2D_PROFILE.version, hash: GAME_2D_PROFILE_HASH });
