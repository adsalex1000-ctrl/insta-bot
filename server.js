import express from 'express';
import { chromium } from 'playwright';
import axios from 'axios';
import fs from 'fs';

const app = express();
app.use(express.json());

const PASTA_SESSAO = '/app/sessao-insta';
const ARQUIVO_COOKIES = `${PASTA_SESSAO}/state.json`;
let ocupado = false;

process.on('unhandledRejection', (e) => console.error('unhandledRejection:', e));
process.on('uncaughtException', (e) => console.error('uncaughtException:', e));

const aleatorio = (min, max) => Math.floor(Math.random() * (max - min + 1)) + min;
const limparTema = (t = '') =>
  t.normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-zA-Z0-9]/g, '').toLowerCase();

app.post('/interagir', async (req, res) => {
  const { tema, webhook_n8n } = req.body || {};
  if (!tema || !webhook_n8n) {
    return res.status(400).json({ status: 'Erro', mensagem: 'Envie tema e webhook_n8n' });
  }
  if (ocupado) {
    return res.status(429).json({ status: 'Ocupado', mensagem: 'Já existe uma execução em andamento' });
  }
  ocupado = true;
  res.json({ status: 'Iniciado', mensagem: `Buscando sobre ${tema}` });

  let browser;
  try {
    browser = await chromium.launchPersistentContext(PASTA_SESSAO, {
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage']
    });

    if (fs.existsSync(ARQUIVO_COOKIES)) {
      const estado = JSON.parse(fs.readFileSync(ARQUIVO_COOKIES, 'utf8'));
      await browser.addCookies(estado.cookies);
    }

    const page = await browser.newPage();
    const hashtag = limparTema(tema);
    console.log(`Iniciando busca por: ${hashtag}`);

    await page.goto(`https://www.instagram.com/explore/tags/${hashtag}/`, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(aleatorio(4000, 6000));

    if (page.url().includes('/accounts/login')) {
      throw new Error('Sessão do Instagram não está logada');
    }

    await page.locator('article img').first().click();
    await page.waitForTimeout(aleatorio(3000, 5000));

    let legenda = 'Post interessante sobre o tema.';
    try {
      legenda = (await page.locator('h1').first().textContent({ timeout: 5000 })) || legenda;
    } catch (e) {}

    const resposta = await axios.post(webhook_n8n, { legenda, tema }, { timeout: 90000 });
    const comentario = resposta.data?.comentario || 'Muito bom!';

    await page.waitForTimeout(aleatorio(12000, 18000)); // "assistindo"

    const btnCurtir = page.locator('svg[aria-label="Curtir"], svg[aria-label="Like"]').first();
    if (await btnCurtir.isVisible()) await btnCurtir.click();

    const caixaTexto = page
      .locator('textarea[placeholder*="Comentar"], textarea[placeholder*="Add a comment"]')
      .first();
    await caixaTexto.click();
    await caixaTexto.fill(comentario);
    await page.waitForTimeout(aleatorio(1500, 3000));
    await caixaTexto.press('Enter');

    console.log('Interação finalizada!');
    await page.waitForTimeout(4000);
  } catch (err) {
    console.error('Erro no robô:', err);
  } finally {
    if (browser) await browser.close();
    ocupado = false;
  }
});

app.listen(3000, () => console.log('Robô Playwright rodando na porta 3000'));
