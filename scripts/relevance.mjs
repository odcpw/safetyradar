// Relevance rules: keep Swiss workplace accidents / prosecutions; drop road traffic, leisure, foreign items.
// Pure keyword + canton heuristics (DE/FR/IT/EN). Returns {keep, reason, score, kind, canton, hazard, industry, outcome}.
const WORK = /arbeitsunfall|betriebsunfall|berufsunfall|baustelle|bauarbeit|bauunfall|arbeiter|mitarbeiter|lernende|lehrling|gabelstapler|stapler|kran|gerüst|schalung|bagger|walze|forst|holzerei|holzschlag|fällarbeit|arbeitsplattform|hubarbeitsbühne|dach(decker|arbeit)|maschine|suva|uvg|arbeitssicherheit|accident de travail|accident du travail|accident professionnel|vigneron|chantier|ouvrier|employé|apprenti|grue|échafaudage|chariot élévateur|travaux (forestiers|d'abattage|de couverture)|bûcheron|engin de chantier|machine|infortunio sul lavoro|sul lavoro|infortunio professionale|cantiere|operaio|operai|lavoratore|apprendista|ponteggio|impalcatura|gru\b|muletto|carrello elevatore|workplace accident|construction site|worker/i;
const ROAD = /verkehrsunfall|linienbus|postauto|reisecar|fahrschul|lieferwagen|personenwagen|\bmofa\b|zug kracht|entgleist|crash|autofahrer|autolenker|lenkerin|lenker\b|fahrerflucht|kollision|frontalkollision|auffahrunfall|velofahrer|töfffahrer|motorrad|e-bike|fussgänger|raser|überholmanöver|parkplatz|a\d{1,2}\b|autobahn|accident de la circulation|automobiliste|motard|cycliste|piéton|collision|autoroute|chauffard|incidente stradale|automobilista|motociclista|ciclista|pedone|autostrada|collisione|road accident|car crash/i;
const LEISURE = /oberstufenzentrum|schüler|schulhaus|élève|allievo|randonn|wander|bergsteig|alpinist|parapente|gleitschirm|crevasse|gletscher|ski|lawine|avalanche|baden|ertrunken|noyade|annegamento|escursionist|montagna|in montagna|homeoffice/i;
const FOREIGN_HOST = /\.(de|at|it|fr|com\.au|co\.uk)$|^(www\.)?(welt|spiegel|nrz|wp|wdr|ndr|swr|br|mdr|zdfheute|tagesschau|abendblatt|focus|bild|stern|merkur|sueddeutsche|faz|zeit|derstandard|krone|orf|corriere|repubblica|ilgiorno|laprovinciadivarese|ilbustese|espansionetv|leprogres|ledauphine|estrepublicain|actu|francebleu|ouest-france|brandaktuell)\./i;
const FOREIGN_PLACE = /\b(deutschland|bayern|baden-württemberg|nrw|österreich|wien|vorarlberg|tirol\b|hamburg|berlin|münchen|stuttgart|italia|lombardia|milano|como\b|varese|france\b|haute-savoie|lyon|paris|neuseeland|new zealand)\b/i;
const RULING = /verurteil|schuldig|freispruch|freigesprochen|strafbefehl|gericht|urteil|staatsanwalt|busse|geldstrafe|condamn|tribunal|jugement|ordonnance pénale|acquitt|prévenu|procès|condann|tribunale|sentenza|processo|prosciolt|assise|decreto d'accusa|convicted|court|ruling/i;
const CANTON_RE = /\b(AG|AI|AR|BE|BL|BS|FR|GE|GL|GR|JU|LU|NE|NW|OW|SG|SH|SO|SZ|TG|TI|UR|VD|VS|ZG|ZH)\b/;
const CANTON_NAMES = { AG:/aargau|argovie/i, BE:/\bbern\b|berne|bernese|bernois/i, BL:/baselland|basel-landschaft/i, BS:/basel-stadt|\bbasel\b|bâle/i, FR:/fribourg|freiburg|friborgo|dompierre|bulle\b|gruyère|le mouret/i, GE:/genève|genf|ginevra|geneva/i, GL:/glarus|glaris/i, GR:/graubünden|grisons|grigioni|chur|coire/i, JU:/\bjura\b|delémont|porrentruy/i, LU:/luzern|lucerne/i, NE:/neuchâtel|neuenburg|chaux-de-fonds/i, SG:/st\.?\s?gallen|saint-gall/i, SH:/schaffhausen/i, SO:/solothurn|soleure/i, SZ:/schwyz/i, TG:/thurgau|thurgovie|frauenfeld/i, TI:/ticino|tessin|lugano|paradiso|biasca|giubiasco|airolo|piotta|quinto|bellinzona|locarno|mendrisio|chiasso|leventina/i, UR:/\buri\b|altdorf/i, VD:/vaud|waadt|lausanne|blonay|renens|bex\b|aigle|vevey|montreux|yverdon|nyon|morges|payerne/i, VS:/valais|wallis|sion|sitten|brig|visp|zermatt|martigny|monthey/i, ZG:/\bzug\b/i, ZH:/zürich|zurich|winterthur|zurigo/i };
const SWISS_HOST = /\.ch$|^(www\.)?(swissinfo|watson|bluewin|blick|20min|nzz|tagesanzeiger|srf|rts|rsi|tio|cdt|laregione|24heures|tdg|lematin|lenouvelliste|arcinfo|lqj|laliberte|aargauerzeitung|luzernerzeitung|tagblatt|bernerzeitung|bazonline|derbund|suedostschweiz)\./i;

const HAZ = [['fall', /stürz|absturz|sturz|chute|tomb|cad[eu]t|precipit|fall/i], ['crane', /kran|grue|\bgru\b|last|charge|carico/i], ['vehicle', /stapler|lastwagen|lkw|camion|chariot|muletto|carrello|fahrzeug|véhicule|veicolo/i], ['machinery', /maschine|machine|macchin|walze|rouleau|bagger|pelle|escavatore|fräs|fraiseuse/i], ['struck', /eingeklemmt|coincé|schiacciat|getroffen|heurté|travolt|baumstamm|tronc|tronco/i], ['explosion', /explosion|esplosion|brand|incendie|incendio/i], ['hazmat', /chemie|chimi|gas|kontamin|contamin|stoff|substance|sostanz/i]];
const IND = [['construction', /bau|chantier|cantiere|gerüst|échafaudage|ponteggio|impalcatura|dach|toit|tetto|schalung|coffrage/i], ['forestry', /forst|holz|baum|forest|arbre|bûcheron|albero|abbatt/i], ['agriculture', /landwirt|bauer|agricol|traktor|tracteur|trattore|ferme|fattoria/i], ['logistics', /lager|logistik|entrepôt|magazzino|stapler|chariot|muletto/i], ['energy', /kraftwerk|centrale|energie|énergie|energia/i], ['chemicals', /labor|chemie|laboratoire|chimi|laboratorio/i]];
const OUT = [['fatal', /tödlich|tot\b|stirbt|gestorben|verstorben|mortel|décéd|décès|tué|mort|mortale|morto|decedut|fatal|killed|†/i], ['life_threatening', /lebensbedrohlich|lebensgefährlich|pronostic vital|pericolo di vita/i], ['serious', /schwer verletzt|grièvement|gravemente|seriously/i], ['injured', /verletzt|blessé|ferit|injur/i]];
const first = (rules, s) => (rules.find(([, re]) => re.test(s)) || [null])[0];

export function classify({ title = '', url = '', lang, kind, sourceCanton, categories = [], trusted, sourceType }) {
  const host = (() => { try { return new URL(url).hostname; } catch { return ''; } })();
  const text = `${title} ${categories.join(' ')}`;
  let canton = sourceCanton || null;
  if (!canton) { const m = title.match(CANTON_RE); if (m) canton = m[1]; }
  if (!canton) for (const [k, re] of Object.entries(CANTON_NAMES)) if (re.test(text)) { canton = k; break; }
  const isRuling = kind === 'ruling' || RULING.test(title);
  const base = { kind: isRuling ? 'ruling' : 'accident', canton, hazard: first(HAZ, text), industry: first(IND, text), outcome: first(OUT, text) };
  const drop = (reason, score = 0) => ({ keep: false, reason, score, ...base });
  if (sourceType === 'entscheidsuche') {
    // Court decisions: keep criminal chambers / Federal Court criminal law; drop administrative & social-insurance chambers.
    if (!/straf|pénal|penal|Bundesgericht I+\. Straf|Tribunal fédéral I+e? Cour de droit pénal/i.test(title)) return drop('court: not a criminal chamber');
    if (/sozialversicherung|assurances sociales|verwaltungsgericht|droit administratif|droit public|amministrativ|IV\.\d|steuer|fiscal/i.test(title)) return drop('court: non-criminal chamber');
    return { keep: true, reason: 'court: criminal decision matching work-safety terms', score: 2, ...base };
  }
  if (FOREIGN_HOST.test(host) && !SWISS_HOST.test(host)) return drop('foreign publisher');
  if (FOREIGN_PLACE.test(text)) return drop('foreign place name');
  const work = WORK.test(text), road = ROAD.test(text), leisure = LEISURE.test(text);
  if (!work && (!trusted || road)) return drop(road ? 'road traffic (no work keyword)' : leisure ? 'leisure/mountain' : 'no workplace keyword');
  if (leisure && !/arbeit|travail|lavoro|forst|forest/i.test(title)) return drop('leisure/mountain');
  if (road && !/arbeitsunfall|accident de travail|infortunio sul lavoro|sul lavoro|baustelle|chantier|cantiere|ouvrier|operaio|arbeiter|stapler|kran|grue/i.test(text)) return drop('road traffic');
  if (!canton && !SWISS_HOST.test(host) && !trusted) return drop('no Swiss canton/publisher signal');
  return { keep: true, reason: trusted ? 'trusted work-accident feed' : 'work keyword + Swiss signal', score: (work ? 2 : 0) + (canton ? 1 : 0) + (trusted ? 1 : 0), ...base };
}
