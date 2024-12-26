import * as THREE from './three.module.js';
import {EffectComposer} from './EffectComposer.js';
import {RenderPass} from './RenderPass.js';
import {ShaderPass} from './ShaderPass.js';

// Initialize scene, camera, and renderer
const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(75, window.innerWidth / window.innerHeight, 0.1, 1000);
const renderer = new THREE.WebGLRenderer();
const aspectRatio = 1080 / 1920;
const width = Math.max(window.innerWidth, window.innerHeight / aspectRatio);
renderer.setSize(width, width * aspectRatio);
let nodeCanvas;

document.body.appendChild(renderer.domElement);

// Load textures
async function loadVideoTexture(id, src) {
    let video = document.getElementById(id) || document.createElement("video");
    video.id = id;
    video.type = 'video/webm';
    video.style.display = 'none';
    document.body.appendChild(video);
    video.src = src;

    return new Promise((resolve, reject) => {
        video.oncanplay = () => {
            const canvas = document.getElementsByTagName('canvas')[0];
            nodeCanvas = canvas
            canvas.style.top = `calc(min(0px, 50vh - 50vw * ${video.videoHeight} / ${video.videoWidth}))`;
            canvas.style.left = `calc(min(0px, 50vw - 50vh / ${video.videoHeight} / ${video.videoWidth}))`;
            resolve(new THREE.VideoTexture(video));
        };
        video.onerror = () => {
            video.remove();
            reject(new Error("Video source not loaded"));
        };
    });
}

async function loadPngTexture(src) {
    const textureLoader = new THREE.TextureLoader();
    return await textureLoader.loadAsync(src);
}

let texture1 = null;
let texture2 = null;
let sensitivity = 1.0;

// Apply user properties
window.wallpaperPropertyListener = {
    applyUserProperties: async function (properties) {
        console.log('Load properties:', Object.entries(properties).filter(e => e[1].value).map(e => `${e[0]}=${e[1].value}`).join(', '));

        const loadTexture = async (type, id, file, defaultFile) => {
            try {
                return await loadVideoTexture(id, file);
            } catch {
                console.log(`'${file}' fail to load, load '${defaultFile}' instead.`);
                return await loadVideoTexture(id, defaultFile);
            }
        };

        if (properties.video?.value) {
            texture1 = await loadTexture('video', 'video', `file:///${properties.video.value}`, 'video.webm');
            shaderPass.uniforms.tImage.value = texture1;
        }

        if (properties.videodepth?.value) {
            texture2 = await loadTexture('videoDepth', 'videoDepth', `file:///${properties.videodepth.value}`, 'videoDepth.webm');
            shaderPass.uniforms.tDepth.value = texture2;
        }

        if (properties.image?.value) {
            try {
                texture1 = await loadPngTexture(`file:///${properties.image.value}`);
            } catch {
                texture1 = await loadPngTexture('image.png');
            }
            shaderPass.uniforms.tImage.value = texture1;
        }

        if (properties.imagedepth?.value) {
            try {
                texture2 = await loadPngTexture(`file:///${properties.imagedepth.value}`);
            } catch {
                texture2 = await loadPngTexture('imageDepth.png');
            }
            shaderPass.uniforms.tDepth.value = texture2;
        }

        if (properties.sensitivity) {
            sensitivity = properties.sensitivity.value;
        }
    },
};


export async function init(pathImage, pathDepth) {


    try {
        texture1 = await loadPngTexture(pathImage);
        texture2 = await loadPngTexture(pathDepth);
    } catch (error) {
        console.error('Error loading default textures:', error);
    }

// Initialize EffectComposer and passes
    const composer = new EffectComposer(renderer);
    const renderPass = new RenderPass(scene, camera);
    composer.addPass(renderPass);

    const shaderPass = new ShaderPass({
        uniforms: {
            tImage: {value: texture1},
            tDepth: {value: texture2},
            mouse: {value: new THREE.Vector2()}
        },
        vertexShader: `
        varying vec2 vUv;
        varying vec4 vPos;
        void main() {
            vUv = uv;
            vPos = modelViewMatrix * vec4(position, 1.0);
            gl_Position = projectionMatrix * vPos;
        }
    `,
        fragmentShader: `
        precision mediump float;
        varying vec2 vUv;
        varying vec4 vPos;
        uniform sampler2D tDepth;
        uniform sampler2D tImage;
        uniform vec2 mouse;

        #define METHOD 1
        #define CORRECT
        #define ENLARGE 1.5
        #define ANTIALIAS 1
        #define AA_TRIGGER 0.8
        #define AA_POWER 1.0
        #define AA_MAXITER 8.0
        #define MAXSTEPS 16.0
        #define CONFIDENCE_MAX 2.5

        #define BRANCHLOOP
        #define BRANCHSAMPLE
        #define DEBUG 0

        #define PERSPECTIVE 0.0
        #define UPSCALE 1.06
        #define COMPRESSION 0.8

        const float perspective = PERSPECTIVE;
        const float upscale = UPSCALE;
        float steps = MAXSTEPS;

        float maskPower = MAXSTEPS * 1.0;
        float correctPower = 1.0;

        const float compression = COMPRESSION;
        const float dmin = (1.0 - compression) / 2.0;
        const float dmax = (1.0 + compression) / 2.0;

        const float vectorCutoff = 0.0 + dmin - 0.0001;

        void main(void) {
            vec2 pos = vec2(vUv[0] - 0.5, 0.5 - vUv[1]) / vec2(upscale) + vec2(0.5);
            mat2 vector = mat2(vec2((0.5 - 0.99) * mouse - mouse/2.0) * vec2(1.5, -1.5),
                              vec2((0.5 - 0.015) * mouse + mouse/2.0) * vec2(1.5, -1.5));
            vector[1] += (vec2(2.0) * pos - vec2(1.0)) * vec2(perspective);

            float dstep = compression / (steps - 1.0);
            vec2 vstep = (vector[1] - vector[0]) / vec2((steps - 1.0));

            vec2 posSum = vec2(0.0);
            float confidenceSum = 0.0;
            float minConfidence = dstep / 2.0;
            float j = 0.0;

            for(float i = 0.0; i < MAXSTEPS; ++i) {
                vec2 vpos = pos + vector[1] - j * vstep;
                float dpos = 0.5 + compression / 2.0 - j * dstep;
                if (dpos >= vectorCutoff && confidenceSum < CONFIDENCE_MAX) {
                    float depth = 1.0 - texture2D(tDepth, vpos * vec2(1, -1) + vec2(0, 1)).r;
                    depth = clamp(depth, dmin, dmax);
                    float confidence = step(dpos, depth + 0.001);

                    if (confidence > AA_TRIGGER && i == j) {
                        j -= 0.5;
                    } else {
                        j += 1.0;
                    }

                    if (confidence > 0.0) {
                        posSum += (vpos + (vec2((depth - dpos) / (dstep * correctPower)) * vstep)) * confidence;
                        confidenceSum += confidence;
                    }
                }
            };

            vec2 posYFlip = posSum / confidenceSum;
            gl_FragColor = texture2D(tImage, vec2(posYFlip[0], 1.0 - posYFlip[1]));
        }
    `
    });
    shaderPass.renderToScreen = true;
    composer.addPass(shaderPass);

// Create a plane geometry and material and add it to the scene
    const geometry = new THREE.PlaneGeometry(2, 2);
    const material = new THREE.MeshBasicMaterial({color: 0xffffff});
    const plane = new THREE.Mesh(geometry, material);
    scene.add(plane);

// Add an event listener for mouse move
    let mouseX = 0, mouseY = 0;
    // window.addEventListener('mousemove', (event) => {
    //     mouseX = (event.clientX / window.innerWidth) - 0.5;
    //     mouseY = 0.5 - (event.clientY / window.innerHeight);
    // });


    // function loop() {
    //     const tm = (new Date()).getTime()/1000
    //     mouseX = Math.cos(tm);
    //     mouseY = Math.sin(tm);
    //     setTimeout(loop, 100)
    // }
    //
    // loop()

// Animate the scene
    let clock = new THREE.Clock();
    let frameDelta = 0, frameInterval = 1 / 30;
    let x = mouseX, y = mouseY;
    let indexFile = 0;

    async function saveCanvas(data, filename) {
        const a = document.createElement("a")
        a.href = data
        a.download = filename
        a.click()
    }

    return async function animate(x) {
        // requestAnimationFrame(animate);

        // tm+=1/10
        mouseX = x;//Math.sin(tm);
        mouseY = -1 / 250;

        shaderPass.uniforms.mouse.value.set(
            mouseX / 100,
            mouseY
        );
        composer.render();

        await saveCanvas(document.querySelector('canvas').toDataURL("image/png"), indexFile + '.png')
        indexFile++;
        // const clockDelta = clock.getDelta();
        // frameDelta += clockDelta;
        // if (frameDelta > frameInterval) {
        //     const k = sensitivity;
        //     x = mouseX * 0.1 * k + x * (1 - 0.1 * k);
        //     y = mouseY * 0.1 * k + y * (1.0 - 0.1 * k);
        //     shaderPass.uniforms.mouse.value.set(
        //         (x * 0.015 * k).clamp(-0.008 * k, 0.008 * k),
        //         (y * 0.015 * k).clamp(-0.008 * k, 0.008 * k)
        //     );
        //     console.log((x * 0.015 * k).clamp(-0.008 * k, 0.008 * k))
        //     composer.render();
        //     frameDelta = 0;
        // }
    }

    // animate();

}