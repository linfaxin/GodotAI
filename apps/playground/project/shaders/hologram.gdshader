// MIT. Four-neighbour alpha outline adapted from Godot's sprite outline demo.
shader_type canvas_item;
render_mode unshaded;
uniform sampler2D image : source_color;
instance uniform float intensity = 1.0;
instance uniform float speed = 1.0;
instance uniform float pointer_x = 0.5;
instance uniform float pointer_y = 0.5;
instance uniform float effect = 0.0;

void fragment() {
    vec2 p = (UV-.5)*vec2(1.4,2.4)+.5;
    float t=TIME*speed;
    p.x += sin(p.y*35.0+t*4.0)*.004*intensity;
    vec4 col=texture(image,p);
    float w=.008*intensity;
    float maxa=col.a;
    maxa=max(maxa,texture(image,p+vec2(w,0.0)).a);
    maxa=max(maxa,texture(image,p-vec2(w,0.0)).a);
    maxa=max(maxa,texture(image,p+vec2(0.0,w)).a);
    maxa=max(maxa,texture(image,p-vec2(0.0,w)).a);
    float in_bounds=step(0.0,p.x)*step(p.x,1.0)*step(0.0,p.y)*step(p.y,1.0);
    float scan=.65+.35*sin(UV.y*600.0-t*5.0);
    vec3 ink=mix(vec3(.1,.9,1.0),vec3(.9,.3,.7),effect*.3);
    vec3 result=col.rgb*ink*col.a*scan+(maxa-col.a)*ink*3.0;
    float grid=pow(max(0.0,sin(UV.x*60.0)*sin(UV.y*100.0)),20.0)*.07;
    COLOR=vec4(vec3(.015,.025,.06)+result*in_bounds+ink*grid,1.0);
}
