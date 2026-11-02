import type { CapabilityProfileV1 } from "../contracts";
import { CODEC_DEFINITIONS, type CodecName, type CodecValue } from "./codecs";
import { CORE_PROFILE, HOST_SCHEMA, type CommandSchema, type HostSchema, type PropertySchema } from "./core";

export type PhysicsHostType = "CharacterBody2D" | "StaticBody2D" | "CollisionShape2D";
const vector = (x: number, y: number) => Object.freeze({ x, y });
const property = (publicName: string, nativeName: string, codec: CodecName, defaultValue: CodecValue, extra: Partial<PropertySchema> = {}): PropertySchema => Object.freeze({ publicName, nativeName, accessName: nativeName, codec, defaultValue, aliases: Object.freeze([publicName]), ...extra, ...(extra.resourceTypes ? { resourceTypes: Object.freeze([...extra.resourceTypes]) } : {}) });
const command = (publicName: string, nativeName: string, arguments_: readonly CodecName[], effects: readonly string[], result?: CodecName): CommandSchema => Object.freeze({ publicName, nativeName, arguments: Object.freeze([...arguments_]), effects: Object.freeze([...effects]), phase: "physics", ...(result === undefined ? {} : { result }) });
const collision = {
  collisionLayer: property("collisionLayer", "collision_layer", "integer", 1, { minimum: 0, maximum: 0xffffffff }),
  collisionMask: property("collisionMask", "collision_mask", "integer", 1, { minimum: 0, maximum: 0xffffffff }),
};
function physicsHost(type: PhysicsHostType, properties: Record<string, PropertySchema>, commands: Record<string, CommandSchema> = {}): HostSchema {
  return Object.freeze({ ...HOST_SCHEMA.Node2D, type, nativeType: type, properties: Object.freeze({ ...HOST_SCHEMA.Node2D.properties, ...properties }), commands: Object.freeze({ ...HOST_SCHEMA.Node2D.commands, ...commands }) });
}
export const PHYSICS_HOST_SCHEMA: Readonly<Record<PhysicsHostType, HostSchema>> = Object.freeze({
  CharacterBody2D: physicsHost("CharacterBody2D", {
    ...collision,
    velocity: property("velocity", "velocity", "vector2", vector(0, 0)),
    upDirection: property("upDirection", "up_direction", "vector2", vector(0, -1), { normalize: "unitVector2" }),
    motionMode: property("motionMode", "motion_mode", "integer", 0, { minimum: 0, maximum: 1 }),
    floorStopOnSlope: property("floorStopOnSlope", "floor_stop_on_slope", "boolean", true),
    floorConstantSpeed: property("floorConstantSpeed", "floor_constant_speed", "boolean", false),
    floorBlockOnWall: property("floorBlockOnWall", "floor_block_on_wall", "boolean", true),
    floorMaxAngle: property("floorMaxAngle", "floor_max_angle", "number", Math.PI / 4, { minimum: 0, maximum: Math.PI }),
    floorSnapLength: property("floorSnapLength", "floor_snap_length", "number", 1, { minimum: 0 }),
    slideOnCeiling: property("slideOnCeiling", "slide_on_ceiling", "boolean", true),
    maxSlides: property("maxSlides", "max_slides", "integer", 4, { minimum: 1, maximum: 2147483647 }),
    wallMinSlideAngle: property("wallMinSlideAngle", "wall_min_slide_angle", "number", Math.PI / 12, { minimum: 0, maximum: Math.PI }),
    safeMargin: property("safeMargin", "safe_margin", "number", 0.08, { minimum: 0 }),
  }, {
    setVelocity: command("setVelocity", "set_velocity", ["vector2"], ["velocity"]),
    moveAndSlide: command("moveAndSlide", "move_and_slide", [], ["transform2d", "velocity"], "boolean"),
  }),
  StaticBody2D: physicsHost("StaticBody2D", {
    ...collision,
    constantLinearVelocity: property("constantLinearVelocity", "constant_linear_velocity", "vector2", vector(0, 0)),
    constantAngularVelocity: property("constantAngularVelocity", "constant_angular_velocity", "number", 0),
  }),
  CollisionShape2D: physicsHost("CollisionShape2D", {
    shape: property("shape", "shape", "assetRef", null, { resourceTypes: ["CircleShape2D", "RectangleShape2D", "CapsuleShape2D"] }),
    disabled: property("disabled", "disabled", "boolean", false),
    oneWayCollision: property("oneWayCollision", "one_way_collision", "boolean", false),
    oneWayCollisionMargin: property("oneWayCollisionMargin", "one_way_collision_margin", "number", 1, { minimum: 0 }),
  }),
});
export const BEHAVIOR_PHYSICS_HOST_SCHEMA: Readonly<Record<string, HostSchema>> = Object.freeze({ ...HOST_SCHEMA, ...PHYSICS_HOST_SCHEMA });
export const BEHAVIOR_PHYSICS_PROFILE: CapabilityProfileV1 = Object.freeze({
  ...CORE_PROFILE, id: "behavior-physics-v1", hosts: Object.freeze(Object.keys(BEHAVIOR_PHYSICS_HOST_SCHEMA)),
  resources: Object.freeze([...CORE_PROFILE.resources, "CircleShape2D", "RectangleShape2D", "CapsuleShape2D"]),
  features: Object.freeze({ ...CORE_PROFILE.features, physics: true }),
});
export const BEHAVIOR_PHYSICS_SCHEMA_DESCRIPTOR = Object.freeze({ profile: BEHAVIOR_PHYSICS_PROFILE, hosts: BEHAVIOR_PHYSICS_HOST_SCHEMA, codecs: CODEC_DEFINITIONS });
/** SHA-256 of canonicalJson(BEHAVIOR_PHYSICS_SCHEMA_DESCRIPTOR), verified by conformance tests. */
export const BEHAVIOR_PHYSICS_PROFILE_HASH = "9c21f0cf123005826d3277547d1d5871b336b931606f353e45afa704ef5827a8";
export const behaviorPhysicsProfileReference = () => Object.freeze({ id: BEHAVIOR_PHYSICS_PROFILE.id, version: BEHAVIOR_PHYSICS_PROFILE.version, hash: BEHAVIOR_PHYSICS_PROFILE_HASH });
