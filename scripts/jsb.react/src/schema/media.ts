import type { CapabilityProfileV1 } from '../contracts';
import { CODEC_DEFINITIONS, type CodecValue } from './codecs';
import { CORE_PROFILE, HOST_SCHEMA, type HostSchema, type PropertySchema } from './core';

export type MediaHostType = 'PanelContainer' | 'MarginContainer' | 'ScrollContainer' | 'TextureRect' | 'ProgressBar' | 'Sprite2D';
const property = (publicName: string, nativeName: string, codec: PropertySchema['codec'], defaultValue: CodecValue, extra: Partial<PropertySchema> = {}): PropertySchema => Object.freeze({ publicName, nativeName, accessName: nativeName, codec, defaultValue, aliases: Object.freeze([publicName]), ...extra, ...(extra.resourceTypes ? { resourceTypes: Object.freeze([...extra.resourceTypes]) } : {}), ...(extra.aliases ? { aliases: Object.freeze([...extra.aliases]) } : {}) });
const integer = (publicName: string, nativeName: string, defaultValue: number, maximum: number, extra: Partial<PropertySchema> = {}) => property(publicName, nativeName, 'integer', defaultValue, { minimum: 0, maximum, ...extra });
const texture = property('texture', 'texture', 'assetRef', null, { resourceTypes: ['Texture2D', 'ImageTexture', 'CompressedTexture2D'] });
function host(type: MediaHostType, base: HostSchema, properties: Record<string, PropertySchema>, signals: HostSchema['signals'] = base.signals): HostSchema {
  return Object.freeze({ ...base, type, nativeType: type, properties: Object.freeze({ ...base.properties, ...properties }), signals: Object.freeze({ ...signals }) });
}

/** UI/media extends core explicitly. It does not enable physics, scripts or IME. */
export const MEDIA_HOST_SCHEMA: Readonly<Record<MediaHostType, HostSchema>> = Object.freeze({
  PanelContainer: host('PanelContainer', HOST_SCHEMA.VBoxContainer, {}),
  MarginContainer: host('MarginContainer', HOST_SCHEMA.VBoxContainer, {
    marginLeft: integer('marginLeft', 'theme_override_constants/margin_left', 0, 16384, { aliases: ['layout.margin.left'] }),
    marginRight: integer('marginRight', 'theme_override_constants/margin_right', 0, 16384, { aliases: ['layout.margin.right'] }),
    marginTop: integer('marginTop', 'theme_override_constants/margin_top', 0, 16384, { aliases: ['layout.margin.top'] }),
    marginBottom: integer('marginBottom', 'theme_override_constants/margin_bottom', 0, 16384, { aliases: ['layout.margin.bottom'] }),
  }),
  ScrollContainer: host('ScrollContainer', HOST_SCHEMA.Control, {
    horizontalScrollMode: integer('horizontalScrollMode', 'horizontal_scroll_mode', 1, 4),
    verticalScrollMode: integer('verticalScrollMode', 'vertical_scroll_mode', 1, 4),
    followFocus: property('followFocus', 'follow_focus', 'boolean', false),
  }),
  TextureRect: host('TextureRect', HOST_SCHEMA.Control, {
    texture,
    mouseFilter: integer('mouseFilter', 'mouse_filter', 1, 2, { aliases: ['input.mouseFilter'] }),
    expandMode: integer('expandMode', 'expand_mode', 0, 5),
    stretchMode: integer('stretchMode', 'stretch_mode', 0, 6),
    flipH: property('flipH', 'flip_h', 'boolean', false),
    flipV: property('flipV', 'flip_v', 'boolean', false),
  }),
  ProgressBar: host('ProgressBar', HOST_SCHEMA.Control, {
    // Fix the native range and disable quantization; arbitrary floating point
    // values in this range must preserve the bridge's stored-value contract.
    minValue: property('minValue', 'min_value', 'number', 0, { minimum: 0, maximum: 0, writeOrder: 10 }),
    maxValue: property('maxValue', 'max_value', 'number', 100, { minimum: 100, maximum: 100, writeOrder: 20 }),
    step: property('step', 'step', 'number', 0, { minimum: 0, maximum: 0, writeOrder: 30 }),
    value: property('value', 'value', 'number', 0, { minimum: 0, maximum: 100, aliases: ['range.value'], writeOrder: 40 }),
    showPercentage: property('showPercentage', 'show_percentage', 'boolean', true),
    fillMode: integer('fillMode', 'fill_mode', 0, 3),
  }, { ...HOST_SCHEMA.Control.signals, onValueChanged: Object.freeze({ publicName: 'onValueChanged', nativeName: 'value_changed', parameters: Object.freeze(['number'] as const), echo: 'suppress' as const }) }),
  Sprite2D: host('Sprite2D', HOST_SCHEMA.Node2D, {
    texture,
    centered: property('centered', 'centered', 'boolean', true),
    offset: property('offset', 'offset', 'vector2', Object.freeze({ x: 0, y: 0 })),
    flipH: property('flipH', 'flip_h', 'boolean', false),
    flipV: property('flipV', 'flip_v', 'boolean', false),
  }),
});
export const UI_MEDIA_HOST_SCHEMA: Readonly<Record<string, HostSchema>> = Object.freeze({ ...HOST_SCHEMA, ...MEDIA_HOST_SCHEMA });
export const UI_MEDIA_PROFILE: CapabilityProfileV1 = Object.freeze({
  ...CORE_PROFILE, id: 'ui-media-v1', hosts: Object.freeze(Object.keys(UI_MEDIA_HOST_SCHEMA)),
  resources: Object.freeze([...CORE_PROFILE.resources, 'Texture2D', 'ImageTexture', 'CompressedTexture2D']),
  features: Object.freeze({ ...CORE_PROFILE.features, media: true }),
});
export const UI_MEDIA_SCHEMA_DESCRIPTOR = Object.freeze({ profile: UI_MEDIA_PROFILE, hosts: UI_MEDIA_HOST_SCHEMA, codecs: CODEC_DEFINITIONS });
/** SHA-256 of canonicalJson(UI_MEDIA_SCHEMA_DESCRIPTOR); conformance tests verify it. */
export const UI_MEDIA_PROFILE_HASH = '5323afc67db82301a6237a6f64d25872ddda340731842796c6d5833a31307da7';
export const uiMediaProfileReference = () => Object.freeze({ id: UI_MEDIA_PROFILE.id, version: UI_MEDIA_PROFILE.version, hash: UI_MEDIA_PROFILE_HASH });
