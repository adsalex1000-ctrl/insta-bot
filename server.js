import express from 'express';
import { chromium } from 'playwright';
import axios from 'axios';
import fs from 'fs';

const app = express();
app.use(express.json());

const PASTA_SESSAO = '/app/sessao-insta';
const ARQUIVO_COOKIES = '/app/state.json';
const ARQUIVO_PRINT = '/tmp/erro.png';

// ===== AJUSTES (mude aqui) =====
const ESPERA_VIDEO_MIN = 15;   // segundos assistindo (mínimo)
const ESPERA_VIDEO_MAX = 40;   // segundos assistindo (máximo)
const SESSAO_MIN = 10;         // minutos da sessão (mínimo)
const SESSAO_MAX = 15;         // minutos da sessão (máximo)
const CHANCE_COMENTAR = 0.4;   // 0.4 = comenta em 40% dos vídeos
const QTD_COMENTARIOS_IA = 3;  // quantos comentários vão para a IA como referência
// ================================

let ocupado = false;
const jaVistos = new Set();

process.on('unhandledRejection', (e) => console.error('unhandledRejection:', e));
process.on('uncaughtException', (e) => console.error('uncaughtException:', e));

const aleatorio = (min, max) => Math.floor(Math.random() * (max - min + 1)) + min;
const embaralhar = (arr) => [...arr].sort(() => Math.random() - 0.5);
const limparTema = (t = '') =>
  t.normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-zA-Z0-9]/g, '').toLowerCase();

async function tirarPrint(page) {
  try { await page.screenshot({ path: ARQUIVO_PRINT }); } catch (e) {}
}

async function coletarLinks(page) {
  const links = new Set();
  for (let i = 0; i < 4; i++) {
    const hrefs = await page.$$eval('a[href*="/p/"], a[href*="/reel/"]', (as) => as.map((a) => a.href));
    hrefs.forEach((h) => links.add(h.split('?')[0]));
    await page.mouse.wheel(0, 1500);
    await page.waitForTimeout(aleatorio(1500, 2500));
  }
  return [...links];
}

// Lê a legenda (primeiro texto da página) e até 20 comentários (os textos seguintes)
async function lerPost(page) {
  const textos = await page.evaluate(() => {
    const raiz = document.querySelector('article') || document.body;
    const vistos = new Set();
    const lista = [];
    raiz.querySelectorAll('span[dir="auto"]').forEach((el) => {
      const t = (el.innerText || '').trim();
      if (t.length >= 12 && t.length <= 600 && !vistos.has(t)) {
        vistos.add(t);
        lista.push(t);
      }
    });
    return lista;
  });
  const legenda = (textos[0] || '').slice(0, 500);
  const comentarios = textos.slice(1, 21).filter((t) => t.length <= 300);
  return { legenda, comentarios };
}

async function processarVideo(page, url, tema, webhook) {
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(aleatorio(3000, 5000));

  // 1. assistir por um tempo sorteado
  const espera = aleatorio(ESPERA_VIDEO_MIN, ESPERA_VIDEO_MAX);
  console.log(`Assistindo ${espera}s: ${url}`);
  await page.waitForTimeout(espera * 1000);

  // 2. curtir
  const btnCurtir = page.locator('svg[aria-label="Curtir"], svg[aria-label="Like"]').first();
  if (await btnCurtir.isVisible().catch(() => false)) {
    await btnCurtir.click();
    await page.waitForTimeout(aleatorio(1000, 2500));
  }

  // 3. salvar o vídeo
  const btnSalvar = page.locator('svg[aria-label="Salvar"], svg[aria-label="Save"]').first();
  if (await btnSalvar.isVisible().catch(() => false)) {
    await btnSalvar.click();
    console.log('Vídeo salvo');
    await page.waitForTimeout(aleatorio(1000, 2500));
  }

  // 4. comentar só em parte dos vídeos
  if (Math.random() > CHANCE_COMENTAR) {
    console.log('Sem comentário neste vídeo');
    return;
  }

  const { legenda, comentarios } = await lerPost(page);
  console.log(`Legenda lida: ${legenda ? legenda.slice(0, 80) : '(nenhuma)'}`);
  console.log(`Comentários lidos: ${comentarios.length}`);
  if (!legenda && comentarios.length === 0) {
    console.log('Nada para a IA ler, pulando');
    return;
  }

  const escolhidos = embaralhar(comentarios).slice(0, QTD_COMENTARIOS_IA);
  const resposta = await axios.post(webhook, { tema, legenda, comentarios: escolhidos }, { timeout: 90000 });
  const comentario = String(resposta.data?.comentario || '').trim().slice(0, 220);
  if (!comentario) {
    console.log('IA não devolveu comentário');
    return;
  }

  const seletorCaixa =
    'textarea[aria-label*="omentário"], textarea[placeholder*="omentário"], textarea[aria-label*="omment"], textarea[placeholder*="omment"]';
  let caixa = page.locator(seletorCaixa).first();
  if (!(await caixa.isVisible().catch(() => false))) {
    // em alguns vídeos a caixa só aparece depois de clicar no ícone de comentar
    await page.locator('svg[aria-label="Comentar"], svg[aria-label="Comment"]').first().click().catch(() => {});
    await page.waitForTimeout(1500);
    caixa = page.locator(seletorCaixa).first();
  }
  await caixa.click({ timeout: 10000 });
  await caixa.pressSequentially(comentario, { delay: aleatorio(60, 140) });
  await page.waitForTimeout(aleatorio(1500, 3000));
  await caixa.press('Enter');
  console.log('Comentou:', comentario);
  await page.waitForTimeout(aleatorio(3000, 6000));
}

app.post('/interagir', async (req, res) => {
  const { tema, webhook_n8n } = req.body || {};
  if (!tema || !webhook_n8n) {
    return res.status(400).json({ status: 'Erro', mensagem: 'Envie tema e webhook_n8n' });
  }
  if (ocupado) {
    return res.status(429).json({ status: 'Ocupado', mensagem: 'Já existe uma sessão em andamento' });
  }
  ocupado = true;
  const duracaoMin = aleatorio(SESSAO_MIN, SESSAO_MAX);
  res.json({ status: 'Iniciado', mensagem: `Sessão de ${duracaoMin} min sobre ${tema}` });

  let browser, page;
  try {
    if (!fs.existsSync(ARQUIVO_COOKIES)) {
      throw new Error('Arquivo /app/state.json não encontrado (Montagem de Arquivo no EasyPanel)');
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
    console.log(`Sessão de ${duracaoMin} min. Tema: ${hashtag}`);

    await page.goto(`https://www.instagram.com/explore/tags/${hashtag}/`, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(aleatorio(4000, 6000));

    const urlAtual = page.url();
    console.log('URL atual:', urlAtual);
    const pedeLogin =
      urlAtual.includes('/accounts/login') ||
      urlAtual.includes('/popular/') ||
      (await page.locator('input[name="username"]').count()) > 0;
    if (pedeLogin) throw new Error('Sessão do Instagram não está logada (refaça o state.json)');

    const links = (await coletarLinks(page)).filter((l) => !jaVistos.has(l));
    console.log(`${links.length} posts encontrados`);

    const fim = Date.now() + duracaoMin * 60 * 1000;
    let errosSeguidos = 0;

    for (const link of links) {
      if (Date.now() >= fim) break;
      jaVistos.add(link);
      try {
        await processarVideo(page, link, tema, webhook_n8n);
        errosSeguidos = 0;
      } catch (e) {
        errosSeguidos++;
        console.error('Erro neste vídeo:', e.message);
        await tirarPrint(page);
        if (errosSeguidos >= 3) throw new Error('3 erros seguidos, encerrando a sessão');
      }
      await page.waitForTimeout(aleatorio(2000, 6000));
    }
    console.log('Sessão finalizada!');
  } catch (err) {
    console.error('Erro no robô:', err);
    await tirarPrint(page);
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
