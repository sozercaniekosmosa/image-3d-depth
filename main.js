import {init} from "./3de/3de.js";


const e = await init('image.png', 'imageDepth.png')
const max = 10;
for (let i = 0; i < max; i++) {
    await e(i / max);
}
