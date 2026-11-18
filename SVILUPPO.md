# Ramo `sviluppo-backend`

Ramo di sviluppo per due lavori che non devono toccare l'app pubblicata (`main` → GitHub Pages) finché non sono verificati:

1. la **taratura** dei parametri empirici del modello di asciugatura;
2. l'uso dei **dati osservati in tempo reale** delle stazioni ARPAV.

## 1. Parametri da tarare (`core.js`)

| Costante | Valore attuale | Significato | Come tararla |
|---|---|---|---|
| `ETA` | 0,7 | Efficienza per affollamento e ombreggiamento sullo stendino | Confronto tra l'ora di asciugatura prevista e quella osservata |
| `LOADS.*.target` | 0,3 / 0,5 / 0,8 kg/m² | Acqua da evaporare per tipo di carico, dopo la centrifuga | Pesata del bucato appena steso e da asciutto |
| `HYGRO_START` | 0,75 | Frazione d'acqua dopo cui inizia la fase igroscopica | Letteratura sulle isoterme di sorbimento del cotone, più osservazioni |
| `hygroFactor` | (100 − UR)/35, limitato tra 0,1 e 1 | Rallentamento dell'evaporazione nella fase igroscopica | Giornate umide (UR > 80%) |
| Vento a quota stendino | 0,6 · u10 | Profilo logaritmico, z0 ≈ 0,1 m | Anemometro locale, o stazioni ARPAV a 5 m |
| `ABS_SW` | 0,6 | Assorbimento della radiazione solare da parte del tessuto bagnato | Tipo di tessuto e colori prevalenti |

**Metodo proposto:** un "diario del bucato" nell'app. Si registrano l'ora in cui si stende, il tipo di carico e l'ora in cui è asciutto. Il backend stima `ETA` e i target con un fit ai minimi quadrati sull'evaporazione cumulata calcolata, usando meteo osservato invece che previsto.

## 2. Dati ARPAV in tempo reale

| Fonte | CORS | Contenuto | Note |
|---|---|---|---|
| `https://www.arpa.veneto.it/api/risorse/data-meteo/xml/Ultime48ore.xml` | sì | 146 stazioni, quasi tutte idrometriche; poche con umidità e vento | 3,5 MB, troppo pesante per il telefono |
| `https://meteo.arpa.veneto.it/meteo/dati_meteo/xml/NNNN.xml` | **no** | Rete meteo completa per stazione: temperatura, umidità, pioggia, vento, radiazione; passo di 30 min, ultime ~48 h | Serve un proxy o backend |

Licenza CC BY 4.0. Gli orari sono in **ora solare**: attenzione al passaggio all'ora legale.

**Architettura proposta (resta gratuita e senza server):** una GitHub Action con cron ogni 30 minuti.
1. Scarica gli XML delle stazioni meteo ARPAV.
2. Estrae le ultime ore di temperatura, umidità, pioggia, vento e radiazione.
3. Pubblica un `obs.json` compatto, di qualche decina di kB, nel sito Pages.

L'app legge `obs.json` dallo stesso dominio, quindi senza problemi di CORS.

**Usi previsti:**
- **Oggi (nowcasting):** se la stazione vicina segnala pioggia in corso o umidità molto più alta del previsto, correggere l'asciugatura e il punteggio di oggi.
- **Pesi dei modelli in base alla verifica recente:** confrontare le previsioni a +24 h dei modelli (API Open-Meteo previous-runs) con le osservazioni ARPAV degli ultimi giorni, per umidità, pioggia sì/no e radiazione. I pesi di `MODELS` vengono adattati in proporzione all'errore recente, mantenendo un minimo per ciascun modello per non dipendere da pochi giorni.
- **Taratura:** fornire il meteo osservato per il fit del punto 1.

Quando una parte è verificata, va unita in `main` con un merge.
