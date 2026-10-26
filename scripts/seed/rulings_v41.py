# v4.1 gap fill (run after rulings_v4.py). Only facts stated by a source; placeholders like "not reported" removed (omit instead).
import json,re
P='/workspace/safetyradar/data/rulings.json'
def L(de,fr,it,en): return {"de":de,"fr":fr,"it":it,"en":en}
src=lambda n,u,l: dict(name=n,url=u,lang=l)
a=json.load(open(P)); R={x['id']:x for x in a}

# Paradiso TI – Tio.ch quotes the written reasons; laRegione confirms verdicts.
p=R['2026-09-02-ti-paradiso-du-lac']
p['appeal']=L("Corte delle Assise correzionali Lugano, Urteil den Parteien am 2.9.2026 eröffnet; schriftliche Begründung am Folgetag. Rechtskraft nicht berichtet.","Cour des assises correctionnelles de Lugano, jugement communiqué le 2.9.2026; motivation écrite le lendemain.","Corte delle Assise correzionali di Lugano, sentenza comunicata il 2.9.2026; motivazioni scritte il giorno seguente.","Lugano Correctional Assizes, verdict notified on 2.9.2026; written reasons the next day.")
p['appeal']['de']="Corte delle Assise correzionali Lugano, Urteil am 2.9.2026 eröffnet; schriftliche Begründung am Folgetag."
p['why']=L("Der Sicherheitsplan sicherte die Zone, in der das durch den Liftschacht geworfene Material ankam, nicht wirksam ab; es fehlte die Gewissheit, dass sich dort niemand aufhält, bis die Würfe beendet sind – etwa mit eindeutigen Lichtsignalen, die vorgesehen, aber verworfen worden waren. Mit diesen Massnahmen wäre der Tod vermeidbar gewesen.",
 "Le plan de sécurité ne protégeait pas efficacement la zone d’arrivée du matériel jeté par la cage d’ascenseur; rien ne garantissait que personne ne s’y trouve avant la fin des lancers – par exemple avec des signaux lumineux clairs, envisagés puis écartés. Avec ces mesures, le décès aurait été évitable.",
 "Il piano di sicurezza non metteva efficacemente in sicurezza la zona di arrivo del materiale gettato dal vano ascensore; mancava la certezza che nessuno vi si trovasse fino alla fine dei lanci – ad esempio con segnali luminosi inequivocabili, previsti ma scartati. Con queste misure il decesso sarebbe stato evitabile.",
 "The safety plan did not effectively secure the zone where material thrown down the lift shaft landed; nothing ensured nobody was there until the throwing had ended – e.g. clear light signals, which had been considered and dropped. With those measures the death would have been avoidable.")
d0,d1,d2=p['defendants']
d0['reasoning']=d0['short']=L("Überwachte Umsetzung und Einhaltung der (ungenügenden) Massnahmen nicht; setzte auch andere Schutzmassnahmen, etwa gegen Absturz am offenen Liftschacht, nicht durch.","N’a pas surveillé la mise en œuvre et le respect des mesures (insuffisantes); n’a pas non plus imposé d’autres protections, notamment contre les chutes à la cage d’ascenseur ouverte.","Non ha sorvegliato attuazione ed esecuzione delle misure (insufficienti); non ha imposto altre protezioni, ad esempio contro le cadute nel vano ascensore aperto.","Did not supervise how the (insufficient) measures were implemented and followed; also failed to enforce other protection, e.g. against falls at the open lift shaft.")
d1['reasoning']=d1['short']=L("Sein Sicherheitsplan sicherte die Ankunftszone des Materials nicht wirksam ab.","Son plan de sécurité ne protégeait pas efficacement la zone d’arrivée du matériel.","Il suo piano di sicurezza non proteggeva efficacemente la zona di arrivo del materiale.","His safety plan did not effectively secure the landing zone for the material.")
d2['reasoning']=d2['short']=L("Freigesprochen: Er hatte die erhaltenen Anweisungen ausgeführt.","Acquitté: il avait exécuté les instructions reçues.","Prosciolto: aveva eseguito le istruzioni ricevute.","Acquitted: he had carried out the instructions he was given.")
p['extraSources']=[src("Tio.ch","https://www.tio.ch/ticino/cronaca/1947586/hotel-lac","it"),src("laRegione","https://epaper.laregione.ch/article/281848650471651","it")]
p['employerRole']=None

# BGer 7B_1323/2024 – why from the decision.
x=R['2026-07-03-bger-7b-1323-2024']
x['why']=L("Der Jugendarbeitsschutz verlangt bei Lernenden an gefährlichen Maschinen eine ständige Überwachung durch eine Fachperson. Der Unfall war für den Ausbildner vorhersehbar; das Mitverschulden des Lernenden (Handschuhe an der drehenden Maschine) entlastet ihn nicht.",
 "La protection des jeunes travailleurs exige une surveillance permanente par un professionnel sur les machines dangereuses. L’accident était prévisible pour le formateur; la faute de l’apprenti (gants sur machine rotative) ne l’exonère pas.",
 "La protezione dei giovani lavoratori impone una sorveglianza costante da parte di un professionista sulle macchine pericolose. L’incidente era prevedibile per il formatore; la colpa dell’apprendista (guanti su macchina rotante) non lo scagiona.",
 "Youth-protection rules require constant supervision by a skilled person when apprentices use dangerous machines. The accident was foreseeable for the trainer; the apprentice's own fault (gloves on a rotating machine) does not relieve him.")
x['defendants'][0]['short']=L("Liess Lernende während seiner Abwesenheit unbeaufsichtigt an der Fräse arbeiten.","A laissé des apprentis sur la fraiseuse sans surveillance pendant son absence.","Ha lasciato apprendisti alla fresatrice senza sorveglianza durante la sua assenza.","Let apprentices work the mill unsupervised while he was away.")
x['defendants'][0]['sanction']['other']=L("Zusatzstrafe zu einem früheren Strafbefehl","Peine complémentaire à une ordonnance pénale antérieure","Pena aggiuntiva a un precedente decreto d’accusa","Additional sentence to an earlier penalty order")

# BGer 6B_365/2025 – why from the decision.
g=R['2025-11-14-bger-6b-365-2025-ge-vigne']
g['why']=L("Die Betriebsanleitung verbot Arbeiten neben dem ungeschützten, laufenden Bohrer. Der Arbeitgeber wusste das und liess trotzdem arbeiten; der Bediener bohrte trotz Person in der Nähe. Bemühungen nach dem Unfall mildern die Strafe nicht.",
 "Le manuel interdisait de travailler à côté de la tarière non protégée en marche. L’employeur le savait et a laissé faire; l’opérateur a foré alors qu’une personne était proche. Les efforts après l’accident ne réduisent pas la peine.",
 "Il manuale vietava di lavorare accanto alla trivella non protetta in funzione. Il datore lo sapeva e ha lasciato fare; l’operatore ha forato con una persona vicina. Gli sforzi dopo l’incidente non riducono la pena.",
 "The manual prohibited working next to the running, unguarded auger. The employer knew and let it happen; the operator drilled with a person close by. Efforts after the accident do not reduce the sentence.")

# Wildhaus SG – trim placeholder.
w=R['2026-06-17-sg-wildhaus-bagger']
w['defendants'][0]['reasoning']=w['defendants'][0]['short']=L("Das Betonelement rutschte aus dem Greifer seines Baggers und traf einen Arbeiter.","L’élément en béton a glissé du grappin de sa pelle et a touché un ouvrier.","L’elemento di cemento è scivolato dalla pinza del suo escavatore colpendo un operaio.","The concrete element slipped from his excavator's grab and struck a worker.")

# Dompierre FR – remove placeholders.
dp=R['2026-03-03-fr-dompierre-pelle']
for d in dp['defendants']: d['reasoning']=None; d['short']=None
dp['defendants'][0]['sanction']['custodial']=L("unbedingte Strafe","peine ferme","pena da scontare","unsuspended sentence")
dp['facts']['what']=L("Der Fuss eines Arbeiters wurde von der Schaufel eines Baggers zerquetscht.","Un ouvrier a eu le pied écrasé par le godet d’une pelle mécanique.","Il piede di un operaio è stato schiacciato dalla benna di un escavatore.","A worker's foot was crushed by an excavator bucket.")

# Generic scrub: drop sentences that only say something is unknown.
PAT=re.compile(r"[^.;]*(nicht berichtet|non rapport|non riportat|not reported|not accessible|nicht zugänglich|non accessible|non accessibil|not summarised|nicht zusammengefasst|non résum|non riassunt)[^.;]*[.;]?\s*",re.I)
def scrub(o):
  if isinstance(o,dict):
    if set(o)=={'de','fr','it','en'}:
      out={k:PAT.sub('',v).strip(' ;') if isinstance(v,str) else v for k,v in o.items()}
      return None if not all(out.values()) else out
    return {k:scrub(v) for k,v in o.items()}
  if isinstance(o,list): return [scrub(v) for v in o]
  return o
a=[scrub(r) for r in a]
json.dump(a,open(P,'w'),ensure_ascii=False,indent=1)
print(len(a))
