// MIT. Playground composition; warp rotation adapted from the official whirl demo.
shader_type canvas_item;
render_mode unshaded;
instance uniform float intensity = 1.0;
instance uniform float speed = 1.0;
instance uniform float pointer_x = 0.5;
instance uniform float pointer_y = 0.5;
instance uniform float effect = 0.0;

void fragment() {
    vec2 p = (UV - 0.5) * vec2(1.0, 1.7);
    float t = TIME * speed * 0.45;
    float angle = length(p) * intensity * 3.0 + t;
    mat2 rot = mat2(vec2(cos(angle), -sin(angle)), vec2(sin(angle), cos(angle)));
    p = rot * p;
    float field = sin(p.x * 9.0 + t) * cos(p.y * 8.0 - t)
        + sin(length(p) * 16.0 - t * 3.0 + pointer_x * 3.0);
    vec3 a = vec3(0.05, 0.8, 0.95);
    vec3 b = vec3(0.7, 0.18, 0.95);
    vec3 col = mix(a, b, 0.5 + 0.5 * sin(field * 2.0 + effect));
    float lines = pow(max(0.0, 1.0 - abs(sin(field * intensity * 2.0))), 5.0);
    float mask = smoothstep(0.72, 0.25, length((UV-0.5)*vec2(1.0,1.2)));
    COLOR = vec4((col * lines * 1.9 + col * 0.12) * mask + vec3(0.015,0.025,0.06), 1.0);
}
