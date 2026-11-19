import express from 'express';
import { chromium } from 'playwright';
import axios from 'axios';
import fs from 'fs';

const app = express();
app.use(express.json());

const PASTA_SESSAO = '/app/sessao-insta';
const ARQUIVO_COOKIES = '/app/state.json';
const ARQUIVO_PRINT = '/tmp/erro.png';
let ocupado = false;

process.on('unhandledRejection', (e) => console.error('unhandledRejection:', e));
process.on('uncaughtException', (e) => console.error('uncaughtException:', e));

const aleatorio = (min, max) => Math.floor(Math.random() * (max - min + 1)) + min;
const limparTema = (t = '') =>
  t.normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-zA-Z0-9]/g, '').toLowerCase();

async function avisarN8n(webhook, dados) {
  try {
    await axios.post(webhook, dados, { timeout: 30000 });
  } catch (e) {
    console.error('Falha ao avisar o n8n:', e.message);
  }
}

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

  let browser, page;
  try {
    if (!fs.existsSync(ARQUIVO_COOKIES)) {
      throw new Error('Arquivo /app/state.json não encontrado (crie a Montagem de Arquivo no EasyPanel)');
    }
    const estado = JSON.parse(fs.readFileSync(ARQUIVO_COOKIES, 'utf8'));

    browser = await chromium.launchPersistentContext(PASTA_SESSAO, {
      headless: true,
      locale: 'pt-BR',
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage']
    });
    await browser.addCookies(estado.cookies || []);

    page = await browser.newPage();
    const hashtag = limparTema(tema);
    console.log(`Iniciando busca por: ${hashtag}`);

    await page.goto(`https://www.instagram.com/explore/tags/${hashtag}/`, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(aleatorio(4000, 6000));

    const urlAtual = page.url();
    console.log('URL atual:', urlAtual);
    console.log('Título:', await page.title());

    const pedeLogin =
      urlAtual.includes('/accounts/login') ||
      urlAtual.includes('/popular/') ||
      (await page.locator('input[name="username"]').count()) > 0;
    if (pedeLogin) throw new Error('Sessão do Instagram não está logada (refaça o state.json)');

    const primeiroPost = page.locator('a[href*="/p/"], a[href*="/reel/"]').first();
    await primeiroPost.waitFor({ timeout: 20000 });
    await primeiroPost.click();
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
      .locator('textarea[placeholder*="omentar"], textarea[placeholder*="Add a comment"]')
      .first();
    await caixaTexto.click();
    await caixaTexto.fill(comentario);
    await page.waitForTimeout(aleatorio(1500, 3000));
    await caixaTexto.press('Enter');

    console.log('Interação finalizada!');
    await page.waitForTimeout(4000);
  } catch (err) {
    console.error('Erro no robô:', err);
    try { await page.screenshot({ path: ARQUIVO_PRINT }); } catch (e) {}
    await avisarN8n(webhook_n8n, { erro: err.message, tema });
  } finally {
    if (browser) await browser.close();
    ocupado = false;
  }
});

app.get('/erro.png', (req, res) => {
  if (!fs.existsSync(ARQUIVO_PRINT)) return res.status(404).send('Sem print ainda');
  res.sendFile(ARQUIVO_PRINT);
});

app.listen(3000, () => console.log('Robô Playwright rodando na porta 3000'));
