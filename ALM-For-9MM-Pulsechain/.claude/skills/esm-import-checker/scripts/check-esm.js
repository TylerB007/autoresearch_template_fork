import fs from 'fs';
import path from 'path';

function walk(dir, cb) {
  if (!fs.existsSync(dir)) return;
  fs.readdirSync(dir).forEach(file => {
    const fullPath = path.join(dir, file);
    if (fs.statSync(fullPath).isDirectory()) {
      if (ignoreDirs.includes(file)) return;
      walk(fullPath, cb);
    } else {
      cb(fullPath);
    }
  });
}

const ignoreDirs = ['node_modules', 'dist', '.git', 'docs', 'logs', 'abis', 'web'];
let errors = 0;

walk('./src', fullPath => {
  if (!fullPath.endsWith('.ts') && !fullPath.endsWith('.tsx')) return;

  const content = fs.readFileSync(fullPath, 'utf8');
  const lines = content.split('\n');

  lines.forEach((line, i) => {
    // Match relative imports/exports:  import ... from './file' or export * from '../file'
    const match = line.match(/(?:import|export)\s+.*?from\s+['"](\.[^'"]+)['"]/);
    if (match) {
      const imp = match[1];
      // Ignored checks for files that don't need .js (like .json)
      if (!imp.endsWith('.js') && !imp.endsWith('.json')) {
        console.error(`[Error] Missing .js extension in ${fullPath}:${i + 1}`);
        console.error(`  > ${line.trim()}`);
        console.error(`  > Fix: Use '${imp}.js' or '${imp}/index.js'\n`);
        errors++;
      }
    }
  });
});

if (errors > 0) {
  console.error(`Found ${errors} missing .js extensions in relative imports.`);
  process.exit(1);
} else {
  console.log("ESM Import Check Passed. All relative imports have .js or .json extensions.");
}