# v3 additions; run after accidents.py. Adds Champéry, Blonay, Le Mouret; stable caseId; ZH extra source.
import json
P='/workspace/safetyradar/data/accidents.json'
def L(de,fr,it,en): return {"de":de,"fr":fr,"it":it,"en":en}
NR=None
def A(id,date,canton,place,industry,hazard,outcome,src,title,activity,what,equipment,injuries,emergency,investigation,lesson):
  return dict(id=id,date=date,dateType="event",canton=canton,place=place,industry=industry,hazard=hazard,outcome=outcome,source=src,
    title=title,facts=dict(activity=activity,what=what,equipment=equipment,injuries=injuries,emergency=emergency,investigation=investigation),lesson=lesson)
INV=L("Strafuntersuchung der Staatsanwaltschaft eröffnet","Instruction ouverte par le Ministère public","Istruzione aperta dal Ministero pubblico","Criminal investigation opened by the prosecutor")
new=[
A("2026-06-26-vs-champery-gaz","2026-06-26","VS","Champéry","industry","hazmat","fatal",
 dict(name="Police cantonale valaisanne",url="https://www.policevalais.ch/communiques-pour-les-medias/champery-un-accident-de-travail-fait-une-victime/",lang="fr"),
 L("Glockenguss: Gase beim Metallschmelzen – ein Toter","Fonte d’une cloche: gaz lors de la fusion du métal – un mort","Fusione di una campana: gas durante la fusione del metallo – un morto","Bell casting: fumes from molten metal – one dead"),
 L("Handwerkliche Herstellung einer Glocke in einer Werkstatt","Fabrication artisanale d’une cloche dans un atelier","Fabbricazione artigianale di una campana in un laboratorio","Hand-casting a bell in a workshop"),
 L("Zwei Männer wurden beim Schmelzen des Metalls aus noch ungeklärtem Grund Gasen ausgesetzt. Sie verliessen die Werkstatt selbst und alarmierten die Rettung; einer brach danach zusammen und starb vor Ort.","Deux hommes ont été exposés à des gaz lors de la fusion du métal, pour une raison encore inconnue. Ils sont sortis seuls de l’atelier et ont alerté les secours; l’un a ensuite fait un malaise et est décédé sur place.","Due uomini sono stati esposti a gas durante la fusione del metallo, per motivi ancora ignoti. Sono usciti da soli dal laboratorio e hanno dato l’allarme; uno ha poi avuto un malore ed è morto sul posto.","Two men were exposed to fumes while melting metal, for reasons not yet known. They left the workshop on their own and called for help; one then collapsed and died at the scene."),
 L("Metallschmelze (Gase)","Fusion de métal (gaz)","Fusione di metallo (gas)","Molten metal (fumes)"),
 L("1 Toter (63), 1 Verletzter (64)","1 mort (63 ans), 1 blessé (64 ans)","1 morto (63 anni), 1 ferito (64 anni)","1 dead (63), 1 injured (64)"),
 L("Reanimation erfolglos; Verletzter per Helikopter ins Universitätsspital Genf","Réanimation sans succès; blessé héliporté aux HUG","Rianimazione senza successo; ferito elitrasportato agli HUG","Resuscitation failed; injured man flown to Geneva University Hospitals"),INV,
 L("Beim Schmelzen von Metall entstehen giftige Dämpfe: nur mit wirksamer Absaugung oder im Freien, Gaswarner und zweiter Fluchtweg.","La fusion de métal dégage des fumées toxiques: aspiration efficace ou plein air, détecteur de gaz et seconde issue.","La fusione di metallo produce fumi tossici: aspirazione efficace o all’aperto, rilevatore di gas e seconda via di fuga.","Melting metal gives off toxic fumes: use effective extraction or work outdoors, a gas detector and a second exit.")),
A("2025-02-04-vd-blonay-foreuse","2025-02-04","VD","Blonay","construction","machinery","fatal",
 dict(name="20 minutes",url="https://www.20min.ch/fr/story/vaud-heurte-par-une-foreuse-un-ouvrier-decede-a-blonay-103274385",lang="fr"),
 L("Bohrgerät kippt am Hang: Arbeiter (26) tödlich getroffen","Une foreuse bascule dans une pente: ouvrier de 26 ans tué","Una trivella si ribalta in pendio: operaio di 26 anni ucciso","Drilling rig tips on slope: worker (26) killed"),
 L("Arbeit mit einem Raupen-Bohrgerät auf einer Baustelle","Travail avec une foreuse sur chenilles sur un chantier","Lavoro con una trivella cingolata in cantiere","Working with a tracked drilling rig on a site"),
 L("Ein Bohrgerät auf Raupen kippte aus ungeklärten Gründen am Hang. Der Mast traf einen Arbeiter.","Une foreuse sur chenilles a basculé dans une pente pour des raisons indéterminées. Son mât a heurté un ouvrier.","Una trivella cingolata si è ribaltata in pendio per motivi non chiariti. Il montante ha colpito un operaio.","A tracked drilling rig tipped over on a slope for unknown reasons. Its mast struck a worker."),
 L("Raupen-Bohrgerät (Mast)","Foreuse sur chenilles (mât)","Trivella cingolata (montante)","Tracked drilling rig (mast)"),
 L("Tödlich","Mortel","Mortale","Fatal"),
 L("Gendarmerie, Ambulanz, Feuerwehr, Suva und Care-Team vor Ort","Gendarmerie, ambulance, pompiers, Suva et équipe de soutien d’urgence","Gendarmeria, ambulanza, pompieri, Suva e team di sostegno","Police, ambulance, fire service, Suva and support team on site"),INV,
 L("Bohrgeräte am Hang: Standsicherheit vorab prüfen, Mast nur auf tragfähigem, ebenem Grund aufstellen – und niemand im Kippbereich.","Foreuse en pente: vérifier la stabilité avant, mât levé seulement sur sol porteur et plan – personne dans la zone de basculement.","Trivelle in pendio: verificare prima la stabilità, montante alzato solo su terreno portante e piano – nessuno nella zona di ribaltamento.","Rigs on slopes: check stability first, raise the mast only on firm level ground – nobody in the tip-over zone.")),
A("2026-03-16-fr-le-mouret-poteau","2026-03-16","FR","Le Mouret","energy","crane","injured",
 dict(name="Police cantonale Fribourg",url="https://www.fr.ch/dsjs/pol/actualites/accident-de-travail-avec-une-personne-blessee-a-le-mouret",lang="fr"),
 L("Strommast fällt auf Kran: Arbeiter erleidet Stromschlag","Un poteau électrique tombe sur une grue: ouvrier électrocuté","Un palo elettrico cade su una gru: operaio folgorato","Power pole falls on crane: worker electrocuted"),
 L("Unterhaltsarbeiten an einer Stromleitung in einem Feld","Travaux d’entretien sur une ligne électrique dans un champ","Lavori di manutenzione su una linea elettrica in un campo","Maintenance on a power line in a field"),
 L("Aus ungeklärtem Grund fiel ein Strommast auf einen Kran, den ein 49-jähriger Arbeiter bediente. Er erlitt einen Stromschlag.","Pour une raison inconnue, un poteau électrique est tombé sur une grue manœuvrée par un ouvrier de 49 ans, qui a été électrocuté.","Per motivi ignoti un palo elettrico è caduto su una gru manovrata da un operaio di 49 anni, rimasto folgorato.","For unknown reasons a power pole fell onto a crane operated by a 49-year-old worker, who was electrocuted."),
 L("Kran, Strommast / Stromleitung","Grue, poteau / ligne électrique","Gru, palo / linea elettrica","Crane, power pole / line"),
 L("Verletzt, mit Helikopter ins Spital (Schwere nicht berichtet)","Blessé, héliporté (gravité non rapportée)","Ferito, elitrasportato (gravità non riportata)","Injured, airlifted (severity not reported)"),
 L("Rega; Care-Team für Mitarbeitende","Rega; équipe psychosociale (EMUPS) pour les collègues","Rega; team psicosociale per i colleghi","Rega air rescue; psychosocial team for co-workers"),INV,
 L("Vor Arbeiten an Freileitungen: freischalten, erden, Masten gegen Umfallen sichern – und Kranausleger aus dem Fallbereich.","Avant de travailler sur une ligne: mise hors tension, mise à terre, poteau assuré contre la chute – flèche de grue hors de la zone de chute.","Prima di lavorare su una linea: disinserire, mettere a terra, assicurare il palo – braccio della gru fuori dalla zona di caduta.","Before line work: de-energise, earth, secure poles against falling – keep crane booms out of the fall zone.")),
]
a=[x for x in json.load(open(P)) if x['id'] not in {n['id'] for n in new}]+new
for x in a:
  x['caseId']='case-'+x['id']
  if x['id']=='2026-09-16-zh-zuerich-bauaufzug': x['extraSources']=[dict(name="20 minutes",url="https://www.20min.ch/fr/story/zurich-deux-morts-apres-l-effondrement-d-un-monte-charge-de-chantier-103634927",lang="fr")]
json.dump(a,open(P,'w'),ensure_ascii=False,indent=2); print(len(a))
