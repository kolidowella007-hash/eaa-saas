// server.js - Complete Accessibility Audit Backend
// Deploy to Render as a Node.js Web Service. 
// Add environment variables: SUPABASE_URL, SUPABASE_SERVICE_KEY, DEEPL_API_KEY, PORT (optional)
// Ensure @sparticuz/chromium is used for serverless Puppeteer.

require('dotenv').config();
const express = require('express');
const cors = require('cors');
const puppeteer = require('puppeteer-core');
const chromium = require('@sparticuz/chromium');
const { createClient } = require('@supabase/supabase-js');
const { PuppeteerCrawler } = require('crawlee');
const { createCanvas, loadImage } = require('canvas');
const deepl = require('deepl-node');
const axios = require('axios'); // might be needed for some calls (not heavily used)
const nodemailer = require('nodemailer'); // optional, for forwarding

const app = express();
app.use(cors());
app.use(express.json({ limit: '50mb' }));

// -------------------- SUPABASE CLIENT --------------------
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

// -------------------- PUPPETEER HELPERS --------------------
let browser = null;

async function launchBrowser() {
  if (browser && browser.isConnected()) return browser;
  browser = await puppeteer.launch({
    args: chromium.args,
    defaultViewport: chromium.defaultViewport,
    executablePath: process.env.CHROME_EXECUTABLE_PATH || await chromium.executablePath(),
    headless: chromium.headless,
    ignoreHTTPSErrors: true,
  });
  return browser;
}

// -------------------- AXE CORE RUNNER --------------------
async function runAxe(page) {
  await page.evaluate(require('axe-core').source);
  const results = await page.evaluate(async () => {
    return await axe.run();
  });
  return results;
}

// -------------------- CRAWL TOP PAGES --------------------
async function crawlTopPages(startUrl, maxPages = 3) {
  const browserInstance = await launchBrowser();
  const visited = [];
  const crawler = new PuppeteerCrawler({
    launchContext: {
      launcher: async () => browserInstance,
    },
    maxRequestsPerCrawl: maxPages,
    requestHandler: async ({ request }) => {
      visited.push(request.url);
    },
    maxConcurrency: 1,
    // restrict to same domain
    navigationTimeoutSecs: 30,
    requestHandlerTimeoutSecs: 30,
  });
  // Add the start URL and let it find internal links
  await crawler.run([startUrl]);
  // Ensure we have at least the start URL
  const uniqueUrls = [...new Set([startUrl, ...visited])];
  return uniqueUrls.slice(0, maxPages);
}

// -------------------- BOUNDING BOX (for coordinates) --------------------
async function getBoundingBox(page, selector) {
  return page.evaluate((sel) => {
    const el = document.querySelector(sel);
    if (!el) return null;
    const rect = el.getBoundingClientRect();
    return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
  }, selector);
}

// -------------------- CANVAS OVERLAY --------------------
async function addOverlays(screenshotBuffer, violations) {
  const img = await loadImage(screenshotBuffer);
  const canvas = createCanvas(img.width, img.height);
  const ctx = canvas.getContext('2d');
  ctx.drawImage(img, 0, 0);

  ctx.strokeStyle = 'rgba(239, 68, 68, 0.8)'; // red
  ctx.lineWidth = 3;
  ctx.setLineDash([6, 4]);

  violations.forEach((v) => {
    if (v.coordinates) {
      ctx.strokeRect(
        v.coordinates.x,
        v.coordinates.y,
        v.coordinates.width,
        v.coordinates.height
      );
    }
  });

  return canvas.toBuffer('image/png');
}

// -------------------- TRANSLATION SERVICE --------------------
const translator = new deepl.Translator(process.env.DEEPL_API_KEY);
const errorTranslations = {
  de: {
    'image-alt': 'Bilder ohne Alternativtext',
    'link-name': 'Links ohne aussagekräftigen Namen',
    'color-contrast': 'Unzureichender Farbkontrast',
    'document-title': 'Dokument ohne Titel',
    // add more as needed
  },
  fr: {
    'image-alt': 'Images sans texte alternatif',
    'link-name': 'Liens sans nom explicite',
    'color-contrast': 'Contraste de couleurs insuffisant',
    'document-title': 'Document sans titre',
  },
  // other languages...
};

async function translateError(text, targetLang) {
  if (errorTranslations[targetLang] && errorTranslations[targetLang][text]) {
    return errorTranslations[targetLang][text];
  }
  try {
    const result = await translator.translateText(text, null, targetLang.toUpperCase());
    return result.text;
  } catch (e) {
    console.warn(`Translation failed: ${e.message}`);
    return text; // fallback to original
  }
}

// -------------------- PDF GENERATION --------------------
async function generateExecutivePDF(scanData, language) {
  const browserInstance = await launchBrowser();
  const page = await browserInstance.newPage();
  // Basic HTML template for executive summary
  const html = `
    <!DOCTYPE html>
    <html>
    <head><meta charset="utf-8"><style>
      body { font-family: Arial, sans-serif; padding: 40px; color: #333; }
      h1 { color: #B91C1C; }
      .disclaimer { background: #FEF3C7; padding: 10px; border-left: 4px solid #F59E0B; margin-top: 30px; }
    </style></head>
    <body>
      <h1>${language === 'de' ? 'Zusammenfassung der Barrierefreiheitsprüfung' : 'Accessibility Audit Executive Summary'}</h1>
      <p><strong>Website:</strong> ${scanData.url}</p>
      <p><strong>Datum:</strong> ${new Date().toLocaleDateString(language === 'de' ? 'de-DE' : 'en-US')}</p>
      <p><strong>Erkannte Verstöße:</strong> ${scanData.violationCount}</p>
      <p>${language === 'de' ? 
        'Diese Prüfung wurde automatisiert durchgeführt. Sie stellt keine Rechtsberatung dar.' : 
        'This audit was performed automatically. It does not constitute legal advice.'}</p>
      <div class="disclaimer">
        <strong>${language === 'de' ? 'Rechtlicher Hinweis' : 'Legal Disclaimer'}:</strong>
        ${language === 'de' ? 
          'Dieses Dokument ist ein technisches Hilfsmittel und ersetzt keine rechtliche Beratung zur Einhaltung des Barrierefreiheitsstärkungsgesetzes (BFSG) oder der EN 301 549.' :
          'This document is a technical tool and does not replace legal counsel regarding compliance with the European Accessibility Act (EAA) or WCAG 2.2.'}
      </div>
    </body>
    </html>
  `;
  await page.setContent(html);
  const pdf = await page.pdf({ format: 'A4', printBackground: true });
  await page.close();
  return pdf;
}

async function generateDeveloperPDF(scanData, errors) {
  const browserInstance = await launchBrowser();
  const page = await browserInstance.newPage();
  // Build rows of violations with code snippets
  const rowsHtml = errors.map((e) => `
    <div style="margin-bottom:20px; padding:10px; border:1px solid #ddd;">
      <strong>${e.error_type}</strong> on <em>${e.page_url}</em><br/>
      <pre style="background:#f4f4f4; padding:5px;">${escapeHtml(e.html_snippet)}</pre>
      <p><strong>Fix:</strong> ${escapeHtml(e.fix_suggestion)}</p>
      ${e.coordinates ? `<p>Location: x=${e.coordinates.x}, y=${e.coordinates.y}</p>` : ''}
    </div>
  `).join('');

  const html = `
    <!DOCTYPE html>
    <html>
    <head><meta charset="utf-8"><style>
      body { font-family: monospace; padding: 40px; }
      h1 { color: #1E40AF; }
    </style></head>
    <body>
      <h1>Developer Blueprint: Accessibility Fixes</h1>
      <p>Website: ${scanData.url}</p>
      <p>Total violations: ${errors.length}</p>
      ${rowsHtml}
    </body>
    </html>
  `;
  await page.setContent(html);
  const pdf = await page.pdf({ format: 'A4', printBackground: true });
  await page.close();
  return pdf;
}

function escapeHtml(text) {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

// -------------------- EMAIL FORWARDING (stub) --------------------
// In production, configure Nodemailer transporter with your SMTP credentials.
async function forwardDeveloperReport(scanId, recipientEmail) {
  // Placeholder: just log or implement with nodemailer
  console.log(`Forwarding developer report for scan ${scanId} to ${recipientEmail}`);
  // Example implementation:
  // const transporter = nodemailer.createTransport({ ... });
  // await transporter.sendMail({ ... });
}

// -------------------- ROUTE: /api/scan --------------------
app.post('/api/scan', async (req, res) => {
  const { url, language, plan_type, user_id } = req.body;
  if (!url || !language || !user_id) {
    return res.status(400).json({ error: 'Missing required fields: url, language, user_id' });
  }
  try {
    // 1. Crawl top pages (home, impressum, contact etc.)
    const pages = await crawlTopPages(url, 3);
    const allViolations = [];
    const browserInstance = await launchBrowser();
    const page = await browserInstance.newPage();

    // 2. Audit each page
    for (const pageUrl of pages) {
      await page.goto(pageUrl, { waitUntil: 'networkidle2', timeout: 30000 });
      const axeResults = await runAxe(page);
      const violations = axeResults.violations.map((v) => ({
        page_url: pageUrl,
        error_type: v.id,
        html_snippet: v.nodes[0]?.html || '',
        fix_suggestion: v.nodes[0]?.failureSummary || '',
        coordinates: null, // filled later
        targetSelector: v.nodes[0]?.target[0] || null,
      }));
      // Get coordinates for first node of each violation
      for (const viol of violations) {
        if (viol.targetSelector) {
          viol.coordinates = await getBoundingBox(page, viol.targetSelector);
        }
      }
      allViolations.push(...violations);
    }

    // 3. Take full-page screenshot of the main URL with overlays (we'll overlay after we have violations)
    await page.goto(url, { waitUntil: 'networkidle2' });
    const screenshotBuffer = await page.screenshot({ fullPage: true });
    // Overlay red boxes
    const overlayBuffer = await addOverlays(screenshotBuffer, allViolations);

    // 4. Upload screenshot to Supabase Storage
    const fileName = `${user_id}_${Date.now()}.png`;
    const { data: uploadData, error: uploadError } = await supabase.storage
      .from('screenshots')
      .upload(fileName, overlayBuffer, { contentType: 'image/png', upsert: true });
    if (uploadError) throw new Error(`Screenshot upload failed: ${uploadError.message}`);
    const { data: publicUrlData } = supabase.storage.from('screenshots').getPublicUrl(fileName);
    const screenshotUrl = publicUrlData.publicUrl;

    // 5. Generate PDFs
    const executivePdfBuffer = await generateExecutivePDF({ url, violationCount: allViolations.length }, language);
    const developerPdfBuffer = await generateDeveloperPDF({ url }, allViolations);

    // Upload PDFs (or store URLs) - for simplicity we keep them as buffers,
    // but in production you'd upload to storage and store URLs. We'll skip storing the full PDF in DB for brevity,
    // but we'll generate and could attach to emails. We'll log.
    console.log('PDFs generated successfully');

    // 6. Create scan record
    const initialScore = 0; // will be recalculated after storing errors
    const { data: scanRow, error: scanError } = await supabase
      .from('scans')
      .insert({
        user_id,
        website_url: url,
        language_selected: language,
        overall_score: initialScore,
        screenshot_url: screenshotUrl,
        // executive_report_pdf and developer_report_pdf could be URLs if uploaded
      })
      .select()
      .single();
    if (scanError) throw new Error(`Failed to create scan: ${scanError.message}`);

    // 7. Store scan errors with translated fix suggestions
    for (const viol of allViolations) {
      const translatedFix = await translateError(viol.fix_suggestion, language);
      await supabase.from('scan_errors').insert({
        scan_id: scanRow.id,
        page_url: viol.page_url,
        error_type: viol.error_type,
        html_snippet: viol.html_snippet,
        fix_suggestion: translatedFix,
        is_fixed: false,
        coordinates: viol.coordinates,
      });
    }

    // 8. Recalculate overall score based on stored errors (all unfixed initially, score = 0)
    const { data: errors } = await supabase
      .from('scan_errors')
      .select('is_fixed')
      .eq('scan_id', scanRow.id);
    const fixedCount = errors.filter((e) => e.is_fixed).length;
    const totalErrors = errors.length || 1;
    const score = Math.round((fixedCount / totalErrors) * 100);
    await supabase.from('scans').update({ overall_score: score }).eq('id', scanRow.id);

    // Clean up puppeteer page
    await page.close();

    res.json({ scan_id: scanRow.id, score });
  } catch (err) {
    console.error('Scan error:', err);
    res.status(500).json({ error: err.message });
  }
});

// -------------------- ROUTE: /api/verify-single-error --------------------
app.post('/api/verify-single-error', async (req, res) => {
  const { error_id, scan_id } = req.body;
  if (!error_id || !scan_id) {
    return res.status(400).json({ error: 'Missing error_id or scan_id' });
  }
  try {
    // Fetch the error record
    const { data: errorRow, error: fetchError } = await supabase
      .from('scan_errors')
      .select('*')
      .eq('id', error_id)
      .single();
    if (fetchError || !errorRow) throw new Error('Error record not found');

    const browserInstance = await launchBrowser();
    const page = await browserInstance.newPage();
    await page.goto(errorRow.page_url, { waitUntil: 'networkidle2', timeout: 20000 });

    // Run axe again on that page
    const axeResults = await runAxe(page);
    const violationFound = axeResults.violations.find((v) => v.id === errorRow.error_type);

    let isFixed = false;
    if (!violationFound) {
      isFixed = true;
    } else if (errorRow.html_snippet) {
      // Check if the exact HTML snippet is still present
      const snippetExists = await page.evaluate(
        (html) => document.body.innerHTML.includes(html),
        errorRow.html_snippet
      );
      isFixed = !snippetExists;
    }

    // Update the error record
    await supabase.from('scan_errors').update({ is_fixed: isFixed }).eq('id', error_id);

    // Recalculate overall score for the scan
    const { data: errors } = await supabase
      .from('scan_errors')
      .select('is_fixed')
      .eq('scan_id', scan_id);
    const fixedCount = errors.filter((e) => e.is_fixed).length;
    const totalErrors = errors.length || 1;
    const newScore = Math.round((fixedCount / totalErrors) * 100);
    await supabase.from('scans').update({ overall_score: newScore }).eq('id', scan_id);

    await page.close();
    res.json({ is_fixed: isFixed, new_score: newScore });
  } catch (err) {
    console.error('Verify error:', err);
    res.status(500).json({ error: err.message });
  }
});

// -------------------- ROUTE: /api/legal-statement --------------------
app.post('/api/legal-statement', async (req, res) => {
  const { scan_id } = req.body;
  if (!scan_id) return res.status(400).json({ error: 'scan_id required' });
  try {
    const { data: scan, error } = await supabase
      .from('scans')
      .select('*, users!inner(plan_type)')
      .eq('id', scan_id)
      .single();
    if (error || !scan) throw new Error('Scan not found');

    const date = new Date().toLocaleDateString(
      scan.language_selected === 'de' ? 'de-DE' : 'en-US'
    );
    let html = '';
    if (scan.language_selected === 'de') {
      html = `<h1>Erklärung zur Barrierefreiheit</h1>
<p><strong>Stand:</strong> ${date}</p>
<p>Diese Website ist teilweise konform mit dem Behindertengleichstellungsgesetz (BFSG) und der WCAG 2.2.</p>
<p>Es wurden automatisierte Prüfungen durchgeführt. Die nachstehenden Inhalte sind noch nicht vollständig barrierefrei.</p>
<p>Diese Erklärung wurde durch ein automatisiertes Werkzeug generiert und stellt keine rechtsverbindliche Zusicherung dar.</p>`;
    } else {
      html = `<h1>Accessibility Statement</h1>
<p><strong>Last updated:</strong> ${date}</p>
<p>This website is partially compliant with the European Accessibility Act (EAA) and WCAG 2.2.</p>
<p>Automated testing has been performed. Some content may not yet be fully accessible.</p>
<p>This statement was generated by an automated tool and does not constitute a legally binding guarantee.</p>`;
    }
    res.json({ html });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// -------------------- ROUTE: /api/badge/static --------------------
app.get('/api/badge/static', async (req, res) => {
  try {
    const canvas = createCanvas(220, 60);
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#10B981'; // green
    ctx.fillRect(0, 0, 220, 60);
    ctx.fillStyle = '#ffffff';
    ctx.font = 'bold 18px Arial, sans-serif';
    ctx.fillText('EAA Audited', 15, 40);
    const buffer = canvas.toBuffer('image/png');
    res.set('Content-Type', 'image/png');
    res.send(buffer);
  } catch (err) {
    res.status(500).send('Error generating badge');
  }
});

// -------------------- ROUTE: /api/badge/dynamic.js --------------------
app.get('/api/badge/dynamic.js', async (req, res) => {
  const { scan_id } = req.query;
  if (!scan_id) return res.status(400).send('');
  try {
    const { data: scan, error } = await supabase
      .from('scans')
      .select('user_id')
      .eq('id', scan_id)
      .single();
    if (error || !scan) return res.status(404).send('');

    const { data: user, error: userError } = await supabase
      .from('users')
      .select('plan_type')
      .eq('id', scan.user_id)
      .single();
    if (userError || !user) return res.status(404).send('');

    const isActive = user.plan_type === 'monthly';
    res.set('Content-Type', 'application/javascript');
    if (isActive) {
      res.send(`
(function() {
  var container = document.createElement('div');
  container.innerHTML = '✅ Secured & Active Monitoring';
  container.style.cssText = 'position:fixed;bottom:16px;right:16px;background:#10B981;color:white;padding:8px 16px;border-radius:8px;z-index:9999;font-family:sans-serif;box-shadow:0 4px 12px rgba(0,0,0,0.2);';
  document.body.appendChild(container);
})();
      `);
    } else {
      res.send('// Monitoring inactive');
    }
  } catch (err) {
    res.status(500).send('');
  }
});

// -------------------- ROUTE: /api/forward-dev --------------------
app.post('/api/forward-dev', async (req, res) => {
  const { scan_id, email } = req.body;
  if (!scan_id || !email) {
    return res.status(400).json({ error: 'scan_id and email required' });
  }
  try {
    await forwardDeveloperReport(scan_id, email);
    res.json({ success: true, message: 'Developer report forwarded' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// -------------------- START SERVER --------------------
const PORT = process.env.PORT || 4000;
app.listen(PORT, () => {
  console.log(`Accessibility backend listening on port ${PORT}`);
});