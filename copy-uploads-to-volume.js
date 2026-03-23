const fs = require('fs');
const path = require('path');

// This script copies files from the Git repo's uploads folder to the Railway Volume
// Run this once after attaching the volume to populate it with existing images

const sourceDir = path.join(__dirname, 'uploads');
const targetDir = '/app/uploads'; // Volume mount path

function copyRecursive(src, dest) {
  if (!fs.existsSync(src)) {
    console.log(`Source directory ${src} does not exist`);
    return;
  }

  if (!fs.existsSync(dest)) {
    fs.mkdirSync(dest, { recursive: true });
  }

  const entries = fs.readdirSync(src, { withFileTypes: true });

  for (let entry of entries) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);

    if (entry.isDirectory()) {
      copyRecursive(srcPath, destPath);
    } else {
      // Only copy if file doesn't exist in destination
      if (!fs.existsSync(destPath)) {
        fs.copyFileSync(srcPath, destPath);
        console.log(`Copied: ${entry.name}`);
      }
    }
  }
}

console.log('Starting upload migration to Volume...');
copyRecursive(sourceDir, targetDir);
console.log('Migration complete!');
