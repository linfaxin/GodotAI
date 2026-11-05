import { ERROR_CODES, fail, type CapabilityProfileV1 } from "../contracts";
import { CODEC_DEFINITIONS } from "./codecs";
import { CORE_SCHEMA_DESCRIPTOR, CORE_PROFILE_HASH, type HostSchema } from "./core";
import { BEHAVIOR_PHYSICS_SCHEMA_DESCRIPTOR, BEHAVIOR_PHYSICS_PROFILE_HASH } from "./physics";
import { UI_MEDIA_SCHEMA_DESCRIPTOR, UI_MEDIA_PROFILE_HASH } from './media';
export interface ProfileSchema {
  readonly profile: CapabilityProfileV1;
  readonly hash: string;
  readonly hosts: Readonly<Record<string, HostSchema>>;
  readonly codecs: typeof CODEC_DEFINITIONS;
}
const profiles: Readonly<Record<string, ProfileSchema>> = Object.freeze({
  "core-ui-v1": Object.freeze({ ...CORE_SCHEMA_DESCRIPTOR, hash: CORE_PROFILE_HASH }),
  "behavior-physics-v1": Object.freeze({ ...BEHAVIOR_PHYSICS_SCHEMA_DESCRIPTOR, hash: BEHAVIOR_PHYSICS_PROFILE_HASH }),
  'ui-media-v1': Object.freeze({ ...UI_MEDIA_SCHEMA_DESCRIPTOR, hash: UI_MEDIA_PROFILE_HASH }),
});
/** Selection is explicit: a host certified in an extension remains unavailable in the default profile. */
export function getProfileSchema(profileId = "core-ui-v1"): ProfileSchema {
  return Object.hasOwn(profiles, profileId) ? profiles[profileId]! : fail(ERROR_CODES.PROFILE, `Uncertified host profile ${profileId}`);
}
export function profileReference(profileId = "core-ui-v1"): Readonly<{ id: string; version: 1; hash: string }> {
  const schema = getProfileSchema(profileId);
  return Object.freeze({ id: schema.profile.id, version: schema.profile.version, hash: schema.hash });
}
