import { createComponent } from "tinybubble";
import { createTranslate } from "bubble-translate/bubble";
import App from "./App.bub.js";
import { discoverHostedServer } from "./connection";

async function bootstrap() {
  const t = createTranslate({
    defaultLang: "en",
    storageKey: "mangayomu.language",
    url: (lang) => `/localization/${lang}.json`
  });
  await t.setLang(t.lang);
  await discoverHostedServer();

  if (!window.location.hash) window.location.hash = "#/";
  createComponent(App).appendTo(document.getElementById("app"));
}

bootstrap();
