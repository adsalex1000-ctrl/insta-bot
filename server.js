import express from 'express';
import { chromium } from 'playwright';
import axios from 'axios';

const app = express();
app.use(express.json());

app.post('/interagir', async (req, res) => {
    const { tema, webhook_n8n } = req.body;
    res.json({ status: 'Iniciado', mensagem: `Buscando sobre ${tema}` });

    const browser = await chromium.launchPersistentContext('/app/sessao-insta', {
        headless: true,
        args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage']
    });

    const page = await browser.newPage();

    try {
        console.log(`Iniciando busca por: ${tema}`);
        await page.goto(`https://www.instagram.com/explore/tags/${tema}/`, { waitUntil: 'networkidle' });
        await page.waitForTimeout(4000);

        await page.locator('article img').first().click();
        await page.waitForTimeout(3000);

        let legenda = "Post interessante sobre o tema.";
        try {
            legenda = await page.locator('h1').first().textContent();
        } catch (e) {}

        const resposta = await axios.post(webhook_n8n, { legenda, tema });
        const comentario = resposta.data.comentario || "Muito bom!";

        await page.waitForTimeout(15000);

        const btnCurtir = page.locator('svg[aria-label="Curtir"], svg[aria-label="Like"]').first();
        if (await btnCurtir.isVisible()) await btnCurtir.click();

        const caixaTexto = page.locator('textarea[placeholder*="Comentar"], textarea[placeholder*="Add a comment"]').first();
        await caixaTexto.click();
        await caixaTexto.fill(comentario);
        await page.waitForTimeout(2000);

        const btnPublicar = page.locator('button:has-text("Publicar"), button:has-text("Post")').first();
        await btnPublicar.click();

        console.log("Interação finalizada!");
        await page.waitForTimeout(4000);

    } catch (err) {
        console.error("Erro no robô:", err);
    } finally {
        await browser.close();
    }
});

app.listen(3000, () => console.log('Robô Playwright rodando na porta 3000'));
