import { createCanvas } from 'canvas';
import fs from 'fs';
import path from 'path';

const { gl, canvas } = setupWebGL();

window.addEventListener('error', (e) => {
  console.error('[Uncaught]', e.error);
});

async function init() {
  const loading = document.getElementById('loading');
  try {
    const config = await window.electron.getConfig();
    if (config.deepseekKey) {
      await loadVRMModel(await window.electron.getVRMPath());
      switchToIdle();
    } else {
      showBubble('请先在设置中配置 DeepSeek API Key', false);
    }
  } catch (err) {
    console.error('[Init]', err);
    showBubble('初始化失败 :(', false);
  } finally {
    loading.classList.add('hidden');
  }
}

init();

animate();

window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});

function animate() {
  requestAnimationFrame(animate);
  if (vrmAnimator) vrmAnimator.update();
  renderer.render(scene, camera);
}
