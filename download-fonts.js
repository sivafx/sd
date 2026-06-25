import fs from 'fs';
import path from 'path';
import https from 'https';

const FONTS_DIR = path.join(process.cwd(), 'public', 'fonts');

// Ensure public/fonts directory exists
if (!fs.existsSync(FONTS_DIR)) {
  fs.mkdirSync(FONTS_DIR, { recursive: true });
}

// 7 Best Google Fonts for canvas drawing and diagramming
const googleFonts = {
  'Inter': 'family=Inter:wght@400;700',
  'Roboto': 'family=Roboto:wght@400;700',
  'Montserrat': 'family=Montserrat:wght@400;700',
  'Playfair Display': 'family=Playfair+Display:wght@400;700',
  'Caveat': 'family=Caveat:wght@400;700',
  'Pacifico': 'family=Pacifico',
  'Fira Code': 'family=Fira+Code:wght@400;700'
};

const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

function fetchText(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { 'User-Agent': USER_AGENT } }, (response) => {
      let data = '';
      response.on('data', (chunk) => { data += chunk; });
      response.on('end', () => resolve(data));
    }).on('error', reject);
  });
}

function downloadFile(url, dest) {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(dest);
    https.get(url, (response) => {
      if (response.statusCode !== 200) {
        reject(new Error(`Status ${response.statusCode}`));
        return;
      }
      response.pipe(file);
      file.on('finish', () => {
        file.close();
        resolve();
      });
    }).on('error', (err) => {
      fs.unlink(dest, () => {});
      reject(err);
    });
  });
}

async function downloadFont(fontName, apiQuery) {
  const url = `https://fonts.googleapis.com/css2?${apiQuery}&display=swap`;
  console.log(`\nFetching stylesheet for ${fontName}...`);
  
  try {
    const cssText = await fetchText(url);
    
    // Regex to find only 'latin' subset blocks
    const latinBlocks = [...cssText.matchAll(/\/\*\s*latin\s*\*\/[\s\S]*?@font-face\s*\{([\s\S]*?)\}/g)];
    
    if (latinBlocks.length === 0) {
      console.warn(`No latin subset font faces found for ${fontName}.`);
      return;
    }

    for (const match of latinBlocks) {
      const block = match[1];
      const weightMatch = block.match(/font-weight:\s*(\d+)/);
      const urlMatch = block.match(/src:\s*url\(([^)]+)\)/);
      
      if (urlMatch) {
        const fontUrl = urlMatch[1].replace(/['"]/g, '');
        const weight = weightMatch ? weightMatch[1] : '400';
        const suffix = weight === '700' ? 'Bold' : 'Regular';
        
        const fileName = `${fontName.replace(/\s+/g, '-')}-${suffix}.woff2`;
        const destPath = path.join(FONTS_DIR, fileName);
        
        console.log(`Downloading ${fontName} (${suffix}) from ${fontUrl}...`);
        await downloadFile(fontUrl, destPath);
        console.log(`Saved -> ${fileName}`);
      }
    }
  } catch (err) {
    console.error(`Error downloading ${fontName}:`, err.message);
  }
}

async function start() {
  console.log('Starting download of 7 best Google Fonts...');
  for (const [fontName, apiQuery] of Object.entries(googleFonts)) {
    await downloadFont(fontName, apiQuery);
  }
  console.log('\nAll font downloads complete!');
}

start();
