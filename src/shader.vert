#version 300 es
// Fullscreen quad. Triangle-strip of 4 verts in clip space (-1..1).
// Outputs UV in 0..1 with (0,0) at bottom-left in GL convention;
// main.js sets UNPACK_FLIP_Y_WEBGL=true so the video sits upright.

in vec2 a_position;
out vec2 v_uv;

void main() {
    v_uv = a_position * 0.5 + 0.5;
    gl_Position = vec4(a_position, 0.0, 1.0);
}
