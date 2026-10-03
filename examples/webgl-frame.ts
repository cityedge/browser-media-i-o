import type { MediaFrame } from 'browser-media-io';

/** Application-side WebGL example. No composition policy is added to the library. */
export class WebGlFrameRenderer {
  readonly gl: WebGLRenderingContext;
  readonly canvas: OffscreenCanvas | HTMLCanvasElement;
  readonly renderer: string;
  #program: WebGLProgram;
  #buffer: WebGLBuffer;
  #texture: WebGLTexture;
  #rotation: WebGLUniformLocation;
  #flip: WebGLUniformLocation;
  constructor(canvas: OffscreenCanvas | HTMLCanvasElement) {
    this.canvas = canvas;
    // Retention makes the direct Canvas writer path safe across asynchronous encoder work.
    const gl = canvas.getContext('webgl', { alpha: false, antialias: false,
      premultipliedAlpha: false, preserveDrawingBuffer: true }) as WebGLRenderingContext | null;
    if (!gl) throw new Error('WebGL is unavailable.');
    this.gl = gl;
    const shader = (type: number, source: string) => {
      const value = gl.createShader(type)!; gl.shaderSource(value, source); gl.compileShader(value);
      if (!gl.getShaderParameter(value, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(value) ?? 'Shader failed');
      return value;
    };
    const vertex = shader(gl.VERTEX_SHADER, `attribute vec2 position; varying vec2 uv;
      void main() { uv = position; gl_Position = vec4(2.0*position.x-1.0, 1.0-2.0*position.y, 0.0, 1.0); }`);
    const fragment = shader(gl.FRAGMENT_SHADER, `precision mediump float; varying vec2 uv;
      uniform sampler2D source; uniform int rotation; uniform bool flip;
      void main() {
        vec2 p = vec2(flip ? 1.0-uv.x : uv.x, uv.y);
        if (rotation == 90) p = vec2(p.y, 1.0-p.x);
        else if (rotation == 180) p = 1.0-p;
        else if (rotation == 270) p = vec2(1.0-p.y, p.x);
        gl_FragColor = texture2D(source, p);
      }`);
    this.#program = gl.createProgram()!;
    gl.attachShader(this.#program, vertex); gl.attachShader(this.#program, fragment); gl.linkProgram(this.#program);
    gl.deleteShader(vertex); gl.deleteShader(fragment);
    if (!gl.getProgramParameter(this.#program, gl.LINK_STATUS)) throw new Error('WebGL program failed');
    gl.useProgram(this.#program);
    this.#rotation = gl.getUniformLocation(this.#program, 'rotation')!;
    this.#flip = gl.getUniformLocation(this.#program, 'flip')!;
    this.#buffer = gl.createBuffer()!; gl.bindBuffer(gl.ARRAY_BUFFER, this.#buffer);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([0, 0, 1, 0, 0, 1, 1, 1]), gl.STATIC_DRAW);
    const position = gl.getAttribLocation(this.#program, 'position');
    gl.enableVertexAttribArray(position); gl.vertexAttribPointer(position, 2, gl.FLOAT, false, 0, 0);
    this.#texture = gl.createTexture()!; gl.bindTexture(gl.TEXTURE_2D, this.#texture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    // UVs are top-to-bottom explicitly. This is separate from the media's horizontal flip.
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    gl.pixelStorei(gl.UNPACK_COLORSPACE_CONVERSION_WEBGL, gl.BROWSER_DEFAULT_WEBGL);
    const debug = gl.getExtension('WEBGL_debug_renderer_info');
    this.renderer = debug ? String(gl.getParameter(debug.UNMASKED_RENDERER_WEBGL)) : String(gl.getParameter(gl.RENDERER));
  }
  draw(frame: MediaFrame, x = 0, y = 0, width = this.canvas.width, height = this.canvas.height) {
    const gl = this.gl, native = frame.toVideoFrame();
    try {
      // VideoFrame upload uses visibleRect; do not crop those pixels a second time.
      // The viewport supplies display sizing (including square-pixel aspect ratio).
      gl.viewport(x, this.canvas.height - y - height, width, height);
      gl.uniform1i(this.#rotation, frame.rotation); gl.uniform1i(this.#flip, Number(frame.flip));
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, native);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
      if (gl.isContextLost()) throw new Error('WebGL context was lost.');
    } finally { native.close(); }
  }
  close() {
    this.gl.deleteTexture(this.#texture); this.gl.deleteBuffer(this.#buffer); this.gl.deleteProgram(this.#program);
    this.gl.getExtension('WEBGL_lose_context')?.loseContext();
  }
}
