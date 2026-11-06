// MIT. Radial UV rotation follows the official screen-space whirl shader.
shader_type canvas_item;
render_mode unshaded;
instance uniform float intensity = 1.0;
instance uniform float speed = 1.0;
instance uniform float pointer_x = 0.5;
instance uniform float pointer_y = 0.5;
instance uniform float effect = 0.0;

void fragment() {
    vec2 p = (UV - 0.5) * vec2(1.0, 1.7);
    p += vec2(pointer_x-0.5, pointer_y-0.5)*0.08;
    float r = length(p);
    float t = TIME*speed;
    float a = atan(p.y,p.x);
    float ring = exp(-abs(r-0.29)*35.0/intensity);
    float sparks = pow(max(0.0,sin(a*23.0-t*3.0+r*50.0)),5.0);
    float spiral = sin(a*(4.0+effect)+r*50.0-t*3.0);
    float halo = exp(-abs(r-.29)*9.0)*(.22+sparks*.65);
    vec3 fire = mix(vec3(.1,.55,1.0),vec3(.8,.35,1.0),.5+.5*sin(a+t));
    vec3 col = fire*(ring*2.2+halo*intensity);
    col += vec3(.17,.08,.4) * pow(max(0.0,spiral),7.0)*smoothstep(.3,.0,r);
    col += vec3(.015,.025,.06);
    COLOR = vec4(col,1.0);
}
