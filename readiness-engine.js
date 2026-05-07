/**
 * Readiness Engine
 * ─────────────────
 * Data model + scoring computation for the Readiness screen.
 * No DB dependency — runs entirely in-memory on raw attempt data.
 *
 * Inputs:  question_attempts[], flashcard_responses[]
 * Outputs: topic_mastery{}, subject_mastery{}
 *
 * Scoring only considers what was attempted — the full question bank
 * size is irrelevant.
 */

// ─────────────────────────────────────────────
// CONSTANTS
// ─────────────────────────────────────────────

const RECENCY_WEIGHT = (daysAgo) => {
  if (daysAgo <= 14)  return 1.00;
  if (daysAgo <= 30)  return 0.85;
  if (daysAgo <= 60)  return 0.65;
  if (daysAgo <= 90)  return 0.40;
  return 0.15;
};

const FLASHCARD_SCORE = { easy: 1.0, know: 0.75, hard: 0.35, forgot: 0.0 };

// Bloom's L1–L2 = recall/comprehension = "Know it"
// Bloom's L3+   = application/analysis = "Use it"
const IS_RECALL      = (level) => level <= 2;
const IS_APPLICATION = (level) => level >= 3;

const THRESHOLDS = {
  min_attempts_to_score: 5,   // below this → not_started
  know_it_developing:    0.55, // know_it must be ≥ this
  use_it_developing:     0.35, // use_it must be ≥ this (else needs_work)
  know_it_exam_ready:    0.72,
  use_it_exam_ready:     0.68,
  min_app_q_exam_ready:  10,   // must have attempted ≥ 10 application Qs
};

// ─────────────────────────────────────────────
// SCHEMA (as JSDoc types for reference)
// ─────────────────────────────────────────────

/**
 * @typedef {Object} QuestionAttempt
 * @property {string}  id
 * @property {string}  user_id
 * @property {string}  question_id
 * @property {string}  topic_id
 * @property {string}  subject_id
 * @property {number}  blooms_level   1–6
 * @property {number}  difficulty     1–3
 * @property {boolean} is_correct
 * @property {number}  [time_taken_ms]
 * @property {string}  source         'qbank' | 'test' | 'exercise'
 * @property {string}  attempted_at   ISO timestamp
 */

/**
 * @typedef {Object} FlashcardResponse
 * @property {string} id
 * @property {string} user_id
 * @property {string} flashcard_id
 * @property {string} topic_id
 * @property {string} subject_id
 * @property {'easy'|'know'|'hard'|'forgot'} response
 * @property {number} blooms_level
 * @property {string} responded_at   ISO timestamp
 */

/**
 * @typedef {Object} TopicMastery
 * @property {string} topic_id
 * @property {string} subject_id
 * @property {number} know_it_score            0.0–1.0
 * @property {number} use_it_score             0.0–1.0
 * @property {number} total_question_attempts
 * @property {number} application_q_attempts   Bloom's L3+
 * @property {number} total_flashcard_responses
 * @property {'not_started'|'needs_work'|'developing'|'exam_ready'} state
 */

/**
 * @typedef {Object} SubjectMastery
 * @property {string} subject_id
 * @property {'not_started'|'needs_work'|'developing'|'exam_ready'} state
 * @property {number} topics_total
 * @property {number} topics_not_started
 * @property {number} topics_needs_work
 * @property {number} topics_developing
 * @property {number} topics_exam_ready
 */

// ─────────────────────────────────────────────
// COMPUTATION
// ─────────────────────────────────────────────

function daysAgo(isoStr) {
  return (Date.now() - new Date(isoStr).getTime()) / (1000 * 60 * 60 * 24);
}

/**
 * Compute mastery for a single topic from raw attempts.
 * Only looks at what was actually attempted — no penalty for unattempted questions.
 */
function computeTopicMastery(topicId, subjectId, attempts, fcResponses) {
  const topicAttempts = attempts.filter(a => a.topic_id === topicId);
  const topicFc       = fcResponses.filter(f => f.topic_id === topicId);

  const totalQ  = topicAttempts.length;
  const totalFc = topicFc.length;

  if (totalQ + totalFc < THRESHOLDS.min_attempts_to_score) {
    return {
      topic_id: topicId, subject_id: subjectId,
      know_it_score: 0, use_it_score: 0,
      total_question_attempts: totalQ,
      application_q_attempts: 0,
      total_flashcard_responses: totalFc,
      state: 'not_started',
    };
  }

  // ── Question-based scores (recency-weighted) ─────────────────────────────
  let recallWeightedCorrect = 0, recallWeightedTotal = 0;
  let appWeightedCorrect    = 0, appWeightedTotal    = 0;
  let appAttempts           = 0;

  for (const a of topicAttempts) {
    const w = RECENCY_WEIGHT(daysAgo(a.attempted_at));
    if (IS_RECALL(a.blooms_level)) {
      recallWeightedTotal   += w;
      if (a.is_correct) recallWeightedCorrect += w;
    } else if (IS_APPLICATION(a.blooms_level)) {
      appWeightedTotal += w;
      if (a.is_correct) appWeightedCorrect += w;
      appAttempts++;
    }
  }

  const qRecallAcc = recallWeightedTotal > 0
    ? recallWeightedCorrect / recallWeightedTotal : null;

  const qUseAcc = appWeightedTotal > 0
    ? appWeightedCorrect / appWeightedTotal : null;

  // ── Flashcard signal (recall only, bolsters know_it) ─────────────────────
  let fcWeightedScore = 0, fcWeightedTotal = 0;

  for (const f of topicFc) {
    const w = RECENCY_WEIGHT(daysAgo(f.responded_at));
    fcWeightedTotal += w;
    fcWeightedScore += FLASHCARD_SCORE[f.response] * w;
  }

  const fcAcc = fcWeightedTotal > 0
    ? fcWeightedScore / fcWeightedTotal : null;

  // ── Blend know_it: 60% Q recall + 40% flashcard ──────────────────────────
  let knowItScore;
  if (qRecallAcc !== null && fcAcc !== null) {
    knowItScore = qRecallAcc * 0.6 + fcAcc * 0.4;
  } else if (qRecallAcc !== null) {
    knowItScore = qRecallAcc;
  } else if (fcAcc !== null) {
    knowItScore = fcAcc * 0.4; // FC only — partial signal
  } else {
    knowItScore = 0;
  }

  const useItScore = qUseAcc ?? 0;

  // ── State ─────────────────────────────────────────────────────────────────
  let state;
  const T = THRESHOLDS;
  if (knowItScore < T.know_it_developing || useItScore < T.use_it_developing) {
    state = 'needs_work';
  } else if (
    knowItScore >= T.know_it_exam_ready &&
    useItScore  >= T.use_it_exam_ready  &&
    appAttempts >= T.min_app_q_exam_ready
  ) {
    state = 'exam_ready';
  } else {
    state = 'developing';
  }

  return {
    topic_id:                   topicId,
    subject_id:                 subjectId,
    know_it_score:              Math.round(knowItScore * 1000) / 1000,
    use_it_score:               Math.round(useItScore  * 1000) / 1000,
    total_question_attempts:    totalQ,
    application_q_attempts:     appAttempts,
    total_flashcard_responses:  totalFc,
    state,
  };
}

/**
 * Compute subject mastery by aggregating its topic states.
 */
function computeSubjectMastery(subjectId, topicMasteryMap) {
  const topics = Object.values(topicMasteryMap)
    .filter(t => t.subject_id === subjectId);

  const counts = { not_started: 0, needs_work: 0, developing: 0, exam_ready: 0 };
  for (const t of topics) counts[t.state]++;

  const total = topics.length;
  if (total === 0) return { subject_id: subjectId, state: 'not_started', topics_total: 0, ...counts };

  const examReadyRatio   = counts.exam_ready / total;
  const progressingRatio = (counts.developing + counts.exam_ready) / total;

  let state;
  if (counts.not_started === total) {
    state = 'not_started';
  } else if (examReadyRatio >= 0.60) {
    state = 'exam_ready';
  } else if (progressingRatio >= 0.30) {
    state = 'developing';
  } else {
    state = 'needs_work';
  }

  return {
    subject_id:         subjectId,
    state,
    topics_total:       total,
    topics_not_started: counts.not_started,
    topics_needs_work:  counts.needs_work,
    topics_developing:  counts.developing,
    topics_exam_ready:  counts.exam_ready,
  };
}

/**
 * Run full readiness computation for a user.
 * @param {QuestionAttempt[]}   attempts
 * @param {FlashcardResponse[]} fcResponses
 * @param {Object[]}            topicIndex   [{ topic_id, subject_id }]
 * @returns {{ topicMastery, subjectMastery }}
 */
function computeReadiness(attempts, fcResponses, topicIndex) {
  const topicMastery = {};
  const subjectIds   = new Set();

  for (const { topic_id, subject_id } of topicIndex) {
    topicMastery[topic_id] = computeTopicMastery(
      topic_id, subject_id, attempts, fcResponses
    );
    subjectIds.add(subject_id);
  }

  const subjectMastery = {};
  for (const subjectId of subjectIds) {
    subjectMastery[subjectId] = computeSubjectMastery(subjectId, topicMastery);
  }

  return { topicMastery, subjectMastery };
}


// ─────────────────────────────────────────────
// DUMMY DATA
// Realistic attempt patterns for Prasad across 6 subjects.
// Only what was actually attempted — no full-bank reference.
// ─────────────────────────────────────────────

const SUBJECTS = {
  // ── Exam Ready ───────────────────────────────
  biochemistry:     { id: 'biochemistry',     name: 'Biochemistry' },
  microbiology:     { id: 'microbiology',     name: 'Microbiology' },
  physiology:       { id: 'physiology',       name: 'Physiology' },
  forensic:         { id: 'forensic',         name: 'Forensic Medicine' },

  // ── Developing ───────────────────────────────
  anatomy:          { id: 'anatomy',          name: 'Anatomy' },
  pharmacology:     { id: 'pharmacology',     name: 'Pharmacology' },
  pathology:        { id: 'pathology',        name: 'Pathology' },
  ent:              { id: 'ent',              name: 'ENT' },
  ophthalmology:    { id: 'ophthalmology',    name: 'Ophthalmology' },
  dermatology:      { id: 'dermatology',      name: 'Dermatology' },

  // ── Needs Work ───────────────────────────────
  surgery:          { id: 'surgery',          name: 'Surgery' },
  obs_gynae:        { id: 'obs_gynae',        name: 'Obs & Gynae' },
  paediatrics:      { id: 'paediatrics',      name: 'Paediatrics' },
  community_med:    { id: 'community_med',    name: 'Community Medicine' },
  medicine:         { id: 'medicine',         name: 'Medicine' },

  // ── Not Started ──────────────────────────────
  psychiatry:       { id: 'psychiatry',       name: 'Psychiatry' },
  orthopaedics:     { id: 'orthopaedics',     name: 'Orthopaedics' },
  radiology:        { id: 'radiology',        name: 'Radiology' },
  anaesthesiology:  { id: 'anaesthesiology',  name: 'Anaesthesiology' },
};

const TOPICS = {
  // ── Anatomy ────────────────────────────────
  embryology:          { id: 'embryology',          subject_id: 'anatomy',         name: 'Embryology' },
  neuroanatomy:        { id: 'neuroanatomy',         subject_id: 'anatomy',         name: 'Neuroanatomy' },
  gross_anatomy:       { id: 'gross_anatomy',        subject_id: 'anatomy',         name: 'Gross Anatomy' },
  histology:           { id: 'histology',            subject_id: 'anatomy',         name: 'Histology' },
  organ_histology:     { id: 'organ_histology',      subject_id: 'anatomy',         name: 'Organ Histology' },
  imaging_clinical:    { id: 'imaging_clinical',     subject_id: 'anatomy',         name: 'Imaging & Clinical' },

  // ── Biochemistry ───────────────────────────
  metabolism:          { id: 'metabolism',           subject_id: 'biochemistry',    name: 'Metabolism' },
  glycolysis:          { id: 'glycolysis',           subject_id: 'biochemistry',    name: 'Glycolysis' },
  lipid_metabolism:    { id: 'lipid_metabolism',     subject_id: 'biochemistry',    name: 'Lipid Metabolism' },
  mol_genetics:        { id: 'mol_genetics',         subject_id: 'biochemistry',    name: 'Molecular Genetics' },
  amino_acids:         { id: 'amino_acids',          subject_id: 'biochemistry',    name: 'Amino Acid Metabolism' },
  vitamins:            { id: 'vitamins',             subject_id: 'biochemistry',    name: 'Vitamins & Minerals' },

  // ── Microbiology ───────────────────────────
  bacteriology:        { id: 'bacteriology',         subject_id: 'microbiology',    name: 'Bacteriology' },
  virology:            { id: 'virology',             subject_id: 'microbiology',    name: 'Virology' },
  mycology:            { id: 'mycology',             subject_id: 'microbiology',    name: 'Mycology' },
  parasitology:        { id: 'parasitology',         subject_id: 'microbiology',    name: 'Parasitology' },

  // ── Physiology ─────────────────────────────
  membrane_physio:     { id: 'membrane_physio',      subject_id: 'physiology',      name: 'Membrane Physiology' },
  cardiac_physio:      { id: 'cardiac_physio',       subject_id: 'physiology',      name: 'Cardiac Physiology' },
  renal_physio:        { id: 'renal_physio',         subject_id: 'physiology',      name: 'Renal Physiology' },
  neuro_physio:        { id: 'neuro_physio',         subject_id: 'physiology',      name: 'Neurophysiology' },
  gi_physio:           { id: 'gi_physio',            subject_id: 'physiology',      name: 'GI Physiology' },

  // ── Pharmacology ───────────────────────────
  general_pharm:       { id: 'general_pharm',        subject_id: 'pharmacology',    name: 'General Pharmacology' },
  autonomic_pharm:     { id: 'autonomic_pharm',      subject_id: 'pharmacology',    name: 'Autonomic Pharmacology' },
  cvs_pharm:           { id: 'cvs_pharm',            subject_id: 'pharmacology',    name: 'CVS Pharmacology' },
  cns_pharm:           { id: 'cns_pharm',            subject_id: 'pharmacology',    name: 'CNS Pharmacology' },
  chemotherapy_pharm:  { id: 'chemotherapy_pharm',   subject_id: 'pharmacology',    name: 'Chemotherapy' },

  // ── Pathology ──────────────────────────────
  general_pathology:   { id: 'general_pathology',    subject_id: 'pathology',       name: 'General Pathology' },
  cellular_pathology:  { id: 'cellular_pathology',   subject_id: 'pathology',       name: 'Cellular Pathology' },
  hematopathology:     { id: 'hematopathology',      subject_id: 'pathology',       name: 'Hematopathology' },
  neoplasia:           { id: 'neoplasia',             subject_id: 'pathology',       name: 'Neoplasia' },
  inflammation:        { id: 'inflammation',          subject_id: 'pathology',       name: 'Inflammation' },

  // ── ENT ────────────────────────────────────
  ear_disorders:       { id: 'ear_disorders',         subject_id: 'ent',             name: 'Ear Disorders' },
  nose_sinuses:        { id: 'nose_sinuses',          subject_id: 'ent',             name: 'Nose & Sinuses' },
  throat_disorders:    { id: 'throat_disorders',      subject_id: 'ent',             name: 'Throat Disorders' },
  head_neck_ent:       { id: 'head_neck_ent',         subject_id: 'ent',             name: 'Head & Neck' },

  // ── Ophthalmology ──────────────────────────
  anterior_segment:    { id: 'anterior_segment',      subject_id: 'ophthalmology',   name: 'Anterior Segment' },
  posterior_segment:   { id: 'posterior_segment',     subject_id: 'ophthalmology',   name: 'Posterior Segment' },
  ocular_motility:     { id: 'ocular_motility',       subject_id: 'ophthalmology',   name: 'Ocular Motility' },
  neuroophthalmology:  { id: 'neuroophthalmology',    subject_id: 'ophthalmology',   name: 'Neuroophthalmology' },

  // ── Dermatology ────────────────────────────
  basic_derm:          { id: 'basic_derm',            subject_id: 'dermatology',     name: 'Basic Dermatology' },
  bacterial_skin:      { id: 'bacterial_skin',        subject_id: 'dermatology',     name: 'Bacterial Infections' },
  autoimmune_skin:     { id: 'autoimmune_skin',       subject_id: 'dermatology',     name: 'Autoimmune Skin' },
  skin_tumours:        { id: 'skin_tumours',          subject_id: 'dermatology',     name: 'Skin Tumours' },

  // ── Forensic Medicine ──────────────────────
  med_jurisprudence:   { id: 'med_jurisprudence',     subject_id: 'forensic',        name: 'Medical Jurisprudence' },
  forensic_path:       { id: 'forensic_path',         subject_id: 'forensic',        name: 'Forensic Pathology' },
  toxicology:          { id: 'toxicology',            subject_id: 'forensic',        name: 'Toxicology' },

  // ── Surgery ────────────────────────────────
  general_surgery:     { id: 'general_surgery',       subject_id: 'surgery',         name: 'General Surgery' },
  gi_surgery:          { id: 'gi_surgery',            subject_id: 'surgery',         name: 'GI Surgery' },
  head_neck_surg:      { id: 'head_neck_surg',        subject_id: 'surgery',         name: 'Head & Neck Surgery' },
  trauma_surg:         { id: 'trauma_surg',           subject_id: 'surgery',         name: 'Trauma Surgery' },

  // ── Obs & Gynae ────────────────────────────
  obstetrics:          { id: 'obstetrics',            subject_id: 'obs_gynae',       name: 'Obstetrics' },
  gynecology:          { id: 'gynecology',            subject_id: 'obs_gynae',       name: 'Gynecology' },
  reproductive_med:    { id: 'reproductive_med',      subject_id: 'obs_gynae',       name: 'Reproductive Medicine' },

  // ── Paediatrics ────────────────────────────
  neonatology:         { id: 'neonatology',           subject_id: 'paediatrics',     name: 'Neonatology' },
  pediatric_infect:    { id: 'pediatric_infect',      subject_id: 'paediatrics',     name: 'Paediatric Infections' },
  pediatric_nutrition: { id: 'pediatric_nutrition',   subject_id: 'paediatrics',     name: 'Nutrition & Growth' },
  developmental_peds:  { id: 'developmental_peds',    subject_id: 'paediatrics',     name: 'Developmental Paeds' },

  // ── Community Medicine ─────────────────────
  epidemiology:        { id: 'epidemiology',          subject_id: 'community_med',   name: 'Epidemiology' },
  biostatistics:       { id: 'biostatistics',         subject_id: 'community_med',   name: 'Biostatistics' },
  maternal_health:     { id: 'maternal_health',       subject_id: 'community_med',   name: 'Maternal & Child Health' },
  health_programmes:   { id: 'health_programmes',     subject_id: 'community_med',   name: 'National Health Programmes' },

  // ── Medicine ───────────────────────────────
  cardiology_med:      { id: 'cardiology_med',        subject_id: 'medicine',        name: 'Cardiology' },
  pulmonology_med:     { id: 'pulmonology_med',       subject_id: 'medicine',        name: 'Pulmonology' },
  gastro_med:          { id: 'gastro_med',            subject_id: 'medicine',        name: 'Gastroenterology' },
  neurology_med:       { id: 'neurology_med',         subject_id: 'medicine',        name: 'Neurology' },

  // ── Psychiatry (not started) ───────────────
  clinical_psychiatry: { id: 'clinical_psychiatry',   subject_id: 'psychiatry',      name: 'Clinical Psychiatry' },
  psychopharmacology:  { id: 'psychopharmacology',    subject_id: 'psychiatry',      name: 'Psychopharmacology' },
  psychotherapy:       { id: 'psychotherapy',         subject_id: 'psychiatry',      name: 'Psychotherapy' },

  // ── Orthopaedics (not started) ─────────────
  fractures_ortho:     { id: 'fractures_ortho',       subject_id: 'orthopaedics',    name: 'Fractures' },
  joint_disorders:     { id: 'joint_disorders',       subject_id: 'orthopaedics',    name: 'Joint Disorders' },
  spinal_disorders:    { id: 'spinal_disorders',      subject_id: 'orthopaedics',    name: 'Spinal Disorders' },

  // ── Radiology (not started) ────────────────
  basic_radiology:     { id: 'basic_radiology',       subject_id: 'radiology',       name: 'Basic Radiology' },
  ct_mri:              { id: 'ct_mri',                subject_id: 'radiology',       name: 'CT & MRI' },
  interventional_rad:  { id: 'interventional_rad',    subject_id: 'radiology',       name: 'Interventional Radiology' },

  // ── Anaesthesiology (not started) ─────────
  general_anaes:       { id: 'general_anaes',         subject_id: 'anaesthesiology', name: 'General Anaesthesia' },
  regional_anaes:      { id: 'regional_anaes',        subject_id: 'anaesthesiology', name: 'Regional Anaesthesia' },
  pain_management:     { id: 'pain_management',       subject_id: 'anaesthesiology', name: 'Pain Management' },
};

/**
 * Generate realistic attempt records for a topic.
 * @param {string}  topicId
 * @param {string}  subjectId
 * @param {Object}  config
 *   recallCount     - how many recall Qs (Bloom's L1–L2) were attempted
 *   recallAccuracy  - fraction correct
 *   appCount        - how many application Qs (Bloom's L3+) were attempted
 *   appAccuracy     - fraction correct
 *   fcCount         - how many flashcard responses
 *   fcProfile       - { easy, know, hard, forgot } fractions (sum = 1)
 *   maxDaysAgo      - spread attempts over this many days
 */
function generateAttempts(topicId, subjectId, config) {
  const now = Date.now();
  const attempts = [];
  const fcResponses = [];

  // Spread timestamps evenly across the window (deterministic, no Math.random)
  const ts = (i, total, maxDays) => {
    const fraction = total <= 1 ? 0.5 : i / (total - 1);
    const ms = fraction * (maxDays || 45) * 24 * 60 * 60 * 1000;
    return new Date(now - ms).toISOString();
  };

  const recallCount  = config.recallCount  || 0;
  const appCount     = config.appCount     || 0;
  const fcCount      = config.fcCount      || 0;
  const recallRight  = Math.round(recallCount * (config.recallAccuracy || 0));
  const appRight     = Math.round(appCount    * (config.appAccuracy    || 0));

  // Recall questions (Bloom's L1–L2) — deterministic correctness
  for (let i = 0; i < recallCount; i++) {
    attempts.push({
      id:           `${topicId}_q_r_${i}`,
      user_id:      'prasad',
      question_id:  `q_${topicId}_r_${i}`,
      topic_id:     topicId,
      subject_id:   subjectId,
      blooms_level: i % 3 === 0 ? 2 : 1,
      difficulty:   1,
      is_correct:   i < recallRight,
      source:       'qbank',
      attempted_at: ts(i, recallCount, config.maxDaysAgo),
    });
  }

  // Application questions (Bloom's L3–L5) — deterministic correctness
  const bloomsCycle = [3, 3, 4, 3, 5];
  for (let i = 0; i < appCount; i++) {
    const bl = bloomsCycle[i % bloomsCycle.length];
    attempts.push({
      id:           `${topicId}_q_a_${i}`,
      user_id:      'prasad',
      question_id:  `q_${topicId}_a_${i}`,
      topic_id:     topicId,
      subject_id:   subjectId,
      blooms_level: bl,
      difficulty:   Math.min(bl, 3),
      is_correct:   i < appRight,
      source:       'qbank',
      attempted_at: ts(i, appCount, config.maxDaysAgo),
    });
  }

  // Flashcard responses — deterministic distribution
  const fcProfile = config.fcProfile || { easy: 0.2, know: 0.4, hard: 0.3, forgot: 0.1 };
  const fcTypes = [];
  for (const [resp, frac] of Object.entries(fcProfile)) {
    const n = Math.round(fcCount * frac);
    for (let i = 0; i < n; i++) fcTypes.push(resp);
  }
  for (let i = 0; i < fcTypes.length; i++) {
    fcResponses.push({
      id:           `${topicId}_fc_${i}`,
      user_id:      'prasad',
      flashcard_id: `fc_${topicId}_${i}`,
      topic_id:     topicId,
      subject_id:   subjectId,
      response:     fcTypes[i],
      blooms_level: 1,
      responded_at: ts(i, fcTypes.length, config.maxDaysAgo),
    });
  }

  return { attempts, fcResponses };
}

// ── Seed configs per topic ────────────────────────────────────────────────────
// Each config produces a realistic state:
//   exam_ready:  high recall + high application + enough app attempts
//   developing:  good recall but weak application OR not enough app attempts
//   needs_work:  weak recall or very weak application
//   not_started: too few attempts

const SEED_CONFIGS = {

  // ═══════════════════════════════════════════════════════════════════════════
  // EXAM READY subjects
  // ═══════════════════════════════════════════════════════════════════════════

  // ── Biochemistry (subject: Exam Ready — 5/6 topics exam_ready) ───────────
  metabolism: {
    recallCount: 14, recallAccuracy: 0.90, appCount: 16, appAccuracy: 0.86,
    fcCount: 20, fcProfile: { easy: 0.50, know: 0.35, hard: 0.10, forgot: 0.05 },
    maxDaysAgo: 15,
  },
  glycolysis: {
    recallCount: 12, recallAccuracy: 0.88, appCount: 13, appAccuracy: 0.82,
    fcCount: 15, fcProfile: { easy: 0.45, know: 0.40, hard: 0.10, forgot: 0.05 },
    maxDaysAgo: 20,
  },
  lipid_metabolism: {
    recallCount: 11, recallAccuracy: 0.85, appCount: 12, appAccuracy: 0.79,
    fcCount: 12, fcProfile: { easy: 0.40, know: 0.40, hard: 0.15, forgot: 0.05 },
    maxDaysAgo: 25,
  },
  mol_genetics: {
    recallCount: 10, recallAccuracy: 0.83, appCount: 12, appAccuracy: 0.74,
    fcCount: 10, fcProfile: { easy: 0.38, know: 0.40, hard: 0.17, forgot: 0.05 },
    maxDaysAgo: 28,
  },
  amino_acids: {
    recallCount: 11, recallAccuracy: 0.87, appCount: 12, appAccuracy: 0.80,
    fcCount: 10, fcProfile: { easy: 0.45, know: 0.38, hard: 0.12, forgot: 0.05 },
    maxDaysAgo: 18,
  },
  vitamins: {
    recallCount: 10, recallAccuracy: 0.84, appCount: 11, appAccuracy: 0.76,
    fcCount: 12, fcProfile: { easy: 0.40, know: 0.42, hard: 0.13, forgot: 0.05 },
    maxDaysAgo: 22,
  },

  // ── Microbiology (subject: Exam Ready — 4/4 topics exam_ready) ───────────
  bacteriology: {
    recallCount: 13, recallAccuracy: 0.91, appCount: 13, appAccuracy: 0.85,
    fcCount: 16, fcProfile: { easy: 0.50, know: 0.38, hard: 0.08, forgot: 0.04 },
    maxDaysAgo: 18,
  },
  virology: {
    recallCount: 12, recallAccuracy: 0.89, appCount: 12, appAccuracy: 0.83,
    fcCount: 14, fcProfile: { easy: 0.48, know: 0.38, hard: 0.10, forgot: 0.04 },
    maxDaysAgo: 20,
  },
  mycology: {
    recallCount: 10, recallAccuracy: 0.88, appCount: 11, appAccuracy: 0.80,
    fcCount: 10, fcProfile: { easy: 0.45, know: 0.40, hard: 0.10, forgot: 0.05 },
    maxDaysAgo: 22,
  },
  parasitology: {
    recallCount: 11, recallAccuracy: 0.86, appCount: 11, appAccuracy: 0.78,
    fcCount: 12, fcProfile: { easy: 0.42, know: 0.40, hard: 0.12, forgot: 0.06 },
    maxDaysAgo: 25,
  },

  // ── Physiology (subject: Exam Ready — 5/5 topics exam_ready) ─────────────
  membrane_physio: {
    recallCount: 13, recallAccuracy: 0.90, appCount: 12, appAccuracy: 0.84,
    fcCount: 14, fcProfile: { easy: 0.48, know: 0.38, hard: 0.10, forgot: 0.04 },
    maxDaysAgo: 20,
  },
  cardiac_physio: {
    recallCount: 14, recallAccuracy: 0.88, appCount: 13, appAccuracy: 0.82,
    fcCount: 16, fcProfile: { easy: 0.46, know: 0.40, hard: 0.10, forgot: 0.04 },
    maxDaysAgo: 22,
  },
  renal_physio: {
    recallCount: 12, recallAccuracy: 0.86, appCount: 12, appAccuracy: 0.79,
    fcCount: 12, fcProfile: { easy: 0.43, know: 0.40, hard: 0.12, forgot: 0.05 },
    maxDaysAgo: 18,
  },
  neuro_physio: {
    recallCount: 11, recallAccuracy: 0.85, appCount: 11, appAccuracy: 0.77,
    fcCount: 10, fcProfile: { easy: 0.42, know: 0.42, hard: 0.11, forgot: 0.05 },
    maxDaysAgo: 25,
  },
  gi_physio: {
    recallCount: 10, recallAccuracy: 0.83, appCount: 11, appAccuracy: 0.75,
    fcCount: 10, fcProfile: { easy: 0.40, know: 0.42, hard: 0.13, forgot: 0.05 },
    maxDaysAgo: 28,
  },

  // ── Forensic Medicine (subject: Exam Ready — 2/3 topics exam_ready) ──────
  med_jurisprudence: {
    recallCount: 12, recallAccuracy: 0.85, appCount: 13, appAccuracy: 0.79,
    fcCount: 14, fcProfile: { easy: 0.42, know: 0.42, hard: 0.11, forgot: 0.05 },
    maxDaysAgo: 22,
  },
  forensic_path: {
    recallCount: 11, recallAccuracy: 0.83, appCount: 12, appAccuracy: 0.76,
    fcCount: 12, fcProfile: { easy: 0.38, know: 0.44, hard: 0.13, forgot: 0.05 },
    maxDaysAgo: 25,
  },
  toxicology: {
    recallCount: 10, recallAccuracy: 0.80, appCount: 11, appAccuracy: 0.73,
    fcCount: 10, fcProfile: { easy: 0.35, know: 0.44, hard: 0.16, forgot: 0.05 },
    maxDaysAgo: 28,
  },

  // ═══════════════════════════════════════════════════════════════════════════
  // DEVELOPING subjects
  // ═══════════════════════════════════════════════════════════════════════════

  // ── Anatomy (subject: Developing — 1 exam_ready, 2 developing, 2 needs_work, 1 not_started) ──
  embryology: {
    recallCount: 10, recallAccuracy: 0.55, appCount: 10, appAccuracy: 0.30,
    fcCount: 8,  fcProfile: { easy: 0.10, know: 0.30, hard: 0.40, forgot: 0.20 },
    maxDaysAgo: 35,
  },
  neuroanatomy: {
    recallCount: 12, recallAccuracy: 0.76, appCount: 12, appAccuracy: 0.51,
    fcCount: 12, fcProfile: { easy: 0.20, know: 0.45, hard: 0.25, forgot: 0.10 },
    maxDaysAgo: 30,
  },
  gross_anatomy: {
    recallCount: 12, recallAccuracy: 0.88, appCount: 14, appAccuracy: 0.81,
    fcCount: 15, fcProfile: { easy: 0.45, know: 0.40, hard: 0.10, forgot: 0.05 },
    maxDaysAgo: 20,
  },
  histology: {
    recallCount: 11, recallAccuracy: 0.70, appCount: 11, appAccuracy: 0.47,
    fcCount: 10, fcProfile: { easy: 0.15, know: 0.40, hard: 0.30, forgot: 0.15 },
    maxDaysAgo: 40,
  },
  organ_histology: {
    recallCount: 8,  recallAccuracy: 0.52, appCount: 8, appAccuracy: 0.34,
    fcCount: 6,  fcProfile: { easy: 0.10, know: 0.25, hard: 0.40, forgot: 0.25 },
    maxDaysAgo: 50,
  },
  imaging_clinical: {
    recallCount: 2,  recallAccuracy: 0.50, appCount: 1, appAccuracy: 0.00,
    fcCount: 0, maxDaysAgo: 60,
  },

  // ── Pharmacology (subject: Developing — 1 exam_ready, 2 developing, 2 not_started) ──
  general_pharm: {
    recallCount: 12, recallAccuracy: 0.85, appCount: 12, appAccuracy: 0.78,
    fcCount: 14, fcProfile: { easy: 0.40, know: 0.42, hard: 0.13, forgot: 0.05 },
    maxDaysAgo: 25,
  },
  autonomic_pharm: {
    recallCount: 10, recallAccuracy: 0.72, appCount: 10, appAccuracy: 0.55,
    fcCount: 10, fcProfile: { easy: 0.20, know: 0.42, hard: 0.28, forgot: 0.10 },
    maxDaysAgo: 32,
  },
  cvs_pharm: {
    recallCount: 9,  recallAccuracy: 0.67, appCount: 9, appAccuracy: 0.50,
    fcCount: 8,  fcProfile: { easy: 0.15, know: 0.40, hard: 0.30, forgot: 0.15 },
    maxDaysAgo: 38,
  },
  cns_pharm: {
    recallCount: 2, recallAccuracy: 0.50, appCount: 1, appAccuracy: 0.00,
    fcCount: 0, maxDaysAgo: 60,
  },
  chemotherapy_pharm: {
    recallCount: 0, recallAccuracy: 0, appCount: 0, appAccuracy: 0,
    fcCount: 0, maxDaysAgo: 60,
  },

  // ── Pathology (subject: Developing — 1 exam_ready, 2 developing, 2 needs_work) ──
  general_pathology: {
    recallCount: 11, recallAccuracy: 0.83, appCount: 12, appAccuracy: 0.76,
    fcCount: 12, fcProfile: { easy: 0.38, know: 0.44, hard: 0.13, forgot: 0.05 },
    maxDaysAgo: 24,
  },
  cellular_pathology: {
    recallCount: 10, recallAccuracy: 0.74, appCount: 10, appAccuracy: 0.58,
    fcCount: 10, fcProfile: { easy: 0.22, know: 0.42, hard: 0.26, forgot: 0.10 },
    maxDaysAgo: 30,
  },
  hematopathology: {
    recallCount: 9,  recallAccuracy: 0.70, appCount: 9, appAccuracy: 0.53,
    fcCount: 8,  fcProfile: { easy: 0.18, know: 0.40, hard: 0.28, forgot: 0.14 },
    maxDaysAgo: 35,
  },
  neoplasia: {
    recallCount: 8,  recallAccuracy: 0.50, appCount: 8, appAccuracy: 0.30,
    fcCount: 6,  fcProfile: { easy: 0.10, know: 0.28, hard: 0.38, forgot: 0.24 },
    maxDaysAgo: 45,
  },
  inflammation: {
    recallCount: 7,  recallAccuracy: 0.46, appCount: 7, appAccuracy: 0.27,
    fcCount: 5,  fcProfile: { easy: 0.08, know: 0.22, hard: 0.40, forgot: 0.30 },
    maxDaysAgo: 48,
  },

  // ── ENT (subject: Developing — 2 developing, 1 needs_work, 1 not_started) ──
  ear_disorders: {
    recallCount: 10, recallAccuracy: 0.73, appCount: 10, appAccuracy: 0.56,
    fcCount: 10, fcProfile: { easy: 0.20, know: 0.44, hard: 0.26, forgot: 0.10 },
    maxDaysAgo: 30,
  },
  nose_sinuses: {
    recallCount: 9,  recallAccuracy: 0.68, appCount: 9, appAccuracy: 0.52,
    fcCount: 8,  fcProfile: { easy: 0.18, know: 0.40, hard: 0.28, forgot: 0.14 },
    maxDaysAgo: 35,
  },
  throat_disorders: {
    recallCount: 8,  recallAccuracy: 0.50, appCount: 8, appAccuracy: 0.28,
    fcCount: 6,  fcProfile: { easy: 0.08, know: 0.24, hard: 0.40, forgot: 0.28 },
    maxDaysAgo: 42,
  },
  head_neck_ent: {
    recallCount: 1, recallAccuracy: 0, appCount: 1, appAccuracy: 0,
    fcCount: 0, maxDaysAgo: 60,
  },

  // ── Ophthalmology (subject: Developing — 2 developing, 1 needs_work, 1 not_started) ──
  anterior_segment: {
    recallCount: 10, recallAccuracy: 0.71, appCount: 10, appAccuracy: 0.54,
    fcCount: 10, fcProfile: { easy: 0.18, know: 0.44, hard: 0.26, forgot: 0.12 },
    maxDaysAgo: 32,
  },
  posterior_segment: {
    recallCount: 9,  recallAccuracy: 0.68, appCount: 9, appAccuracy: 0.50,
    fcCount: 8,  fcProfile: { easy: 0.16, know: 0.40, hard: 0.30, forgot: 0.14 },
    maxDaysAgo: 36,
  },
  ocular_motility: {
    recallCount: 7,  recallAccuracy: 0.48, appCount: 7, appAccuracy: 0.26,
    fcCount: 5,  fcProfile: { easy: 0.08, know: 0.24, hard: 0.38, forgot: 0.30 },
    maxDaysAgo: 44,
  },
  neuroophthalmology: {
    recallCount: 0, recallAccuracy: 0, appCount: 0, appAccuracy: 0,
    fcCount: 0, maxDaysAgo: 60,
  },

  // ── Dermatology (subject: Developing — 2 developing, 2 not_started) ──────
  basic_derm: {
    recallCount: 18, recallAccuracy: 0.76, appCount: 16, appAccuracy: 0.60,
    fcCount: 14, fcProfile: { easy: 0.22, know: 0.44, hard: 0.24, forgot: 0.10 },
    maxDaysAgo: 30,
  },
  bacterial_skin: {
    recallCount: 16, recallAccuracy: 0.79, appCount: 15, appAccuracy: 0.62,
    fcCount: 12, fcProfile: { easy: 0.22, know: 0.44, hard: 0.24, forgot: 0.10 },
    maxDaysAgo: 36,
  },
  autoimmune_skin: {
    recallCount: 0, recallAccuracy: 0, appCount: 0, appAccuracy: 0,
    fcCount: 0, maxDaysAgo: 60,
  },
  skin_tumours: {
    recallCount: 0, recallAccuracy: 0, appCount: 0, appAccuracy: 0,
    fcCount: 0, maxDaysAgo: 60,
  },

  // ═══════════════════════════════════════════════════════════════════════════
  // NEEDS WORK subjects
  // ═══════════════════════════════════════════════════════════════════════════

  // ── Surgery (subject: Needs Work — 1 developing, 3 needs_work) ───────────
  general_surgery: {
    recallCount: 9,  recallAccuracy: 0.62, appCount: 9, appAccuracy: 0.44,
    fcCount: 7,  fcProfile: { easy: 0.12, know: 0.36, hard: 0.32, forgot: 0.20 },
    maxDaysAgo: 40,
  },
  gi_surgery: {
    recallCount: 8,  recallAccuracy: 0.48, appCount: 8, appAccuracy: 0.28,
    fcCount: 5,  fcProfile: { easy: 0.06, know: 0.22, hard: 0.40, forgot: 0.32 },
    maxDaysAgo: 45,
  },
  head_neck_surg: {
    recallCount: 7,  recallAccuracy: 0.43, appCount: 7, appAccuracy: 0.24,
    fcCount: 5,  fcProfile: { easy: 0.06, know: 0.20, hard: 0.38, forgot: 0.36 },
    maxDaysAgo: 48,
  },
  trauma_surg: {
    recallCount: 6,  recallAccuracy: 0.40, appCount: 6, appAccuracy: 0.20,
    fcCount: 4,  fcProfile: { easy: 0.05, know: 0.18, hard: 0.40, forgot: 0.37 },
    maxDaysAgo: 50,
  },

  // ── Obs & Gynae (subject: Needs Work — 3 needs_work) ─────────────────────
  obstetrics: {
    recallCount: 9,  recallAccuracy: 0.44, appCount: 9, appAccuracy: 0.20,
    fcCount: 7,  fcProfile: { easy: 0.06, know: 0.22, hard: 0.40, forgot: 0.32 },
    maxDaysAgo: 42,
  },
  gynecology: {
    recallCount: 8,  recallAccuracy: 0.46, appCount: 8, appAccuracy: 0.26,
    fcCount: 6,  fcProfile: { easy: 0.06, know: 0.22, hard: 0.40, forgot: 0.32 },
    maxDaysAgo: 46,
  },
  reproductive_med: {
    recallCount: 7,  recallAccuracy: 0.43, appCount: 6, appAccuracy: 0.22,
    fcCount: 4,  fcProfile: { easy: 0.05, know: 0.20, hard: 0.38, forgot: 0.37 },
    maxDaysAgo: 50,
  },

  // ── Paediatrics (subject: Needs Work — 1 developing, 3 needs_work) ───────
  neonatology: {
    recallCount: 9,  recallAccuracy: 0.63, appCount: 9, appAccuracy: 0.46,
    fcCount: 8,  fcProfile: { easy: 0.12, know: 0.36, hard: 0.32, forgot: 0.20 },
    maxDaysAgo: 38,
  },
  pediatric_infect: {
    recallCount: 8,  recallAccuracy: 0.47, appCount: 8, appAccuracy: 0.27,
    fcCount: 5,  fcProfile: { easy: 0.06, know: 0.22, hard: 0.40, forgot: 0.32 },
    maxDaysAgo: 44,
  },
  pediatric_nutrition: {
    recallCount: 7,  recallAccuracy: 0.44, appCount: 7, appAccuracy: 0.24,
    fcCount: 4,  fcProfile: { easy: 0.06, know: 0.20, hard: 0.38, forgot: 0.36 },
    maxDaysAgo: 48,
  },
  developmental_peds: {
    recallCount: 6,  recallAccuracy: 0.40, appCount: 6, appAccuracy: 0.20,
    fcCount: 3,  fcProfile: { easy: 0.05, know: 0.18, hard: 0.40, forgot: 0.37 },
    maxDaysAgo: 52,
  },

  // ── Community Medicine (subject: Needs Work — 1 developing, 2 needs_work, 1 not_started) ──
  epidemiology: {
    recallCount: 9,  recallAccuracy: 0.64, appCount: 9, appAccuracy: 0.45,
    fcCount: 8,  fcProfile: { easy: 0.10, know: 0.35, hard: 0.35, forgot: 0.20 },
    maxDaysAgo: 45,
  },
  biostatistics: {
    recallCount: 7,  recallAccuracy: 0.43, appCount: 7, appAccuracy: 0.26,
    fcCount: 5,  fcProfile: { easy: 0.05, know: 0.20, hard: 0.40, forgot: 0.35 },
    maxDaysAgo: 40,
  },
  maternal_health: {
    recallCount: 5,  recallAccuracy: 0.40, appCount: 5, appAccuracy: 0.22,
    fcCount: 3,  fcProfile: { easy: 0.05, know: 0.20, hard: 0.40, forgot: 0.35 },
    maxDaysAgo: 50,
  },
  health_programmes: {
    recallCount: 0, appCount: 0, fcCount: 0, maxDaysAgo: 60,
  },

  // ── Medicine (subject: Needs Work — 1 developing, 3 needs_work) ──────────
  cardiology_med: {
    recallCount: 9,  recallAccuracy: 0.63, appCount: 9, appAccuracy: 0.46,
    fcCount: 8,  fcProfile: { easy: 0.12, know: 0.36, hard: 0.32, forgot: 0.20 },
    maxDaysAgo: 36,
  },
  pulmonology_med: {
    recallCount: 8,  recallAccuracy: 0.49, appCount: 8, appAccuracy: 0.28,
    fcCount: 5,  fcProfile: { easy: 0.06, know: 0.22, hard: 0.40, forgot: 0.32 },
    maxDaysAgo: 42,
  },
  gastro_med: {
    recallCount: 7,  recallAccuracy: 0.44, appCount: 7, appAccuracy: 0.25,
    fcCount: 4,  fcProfile: { easy: 0.06, know: 0.20, hard: 0.38, forgot: 0.36 },
    maxDaysAgo: 46,
  },
  neurology_med: {
    recallCount: 6,  recallAccuracy: 0.42, appCount: 6, appAccuracy: 0.22,
    fcCount: 3,  fcProfile: { easy: 0.05, know: 0.18, hard: 0.40, forgot: 0.37 },
    maxDaysAgo: 50,
  },

  // ═══════════════════════════════════════════════════════════════════════════
  // NOT STARTED subjects — zero attempts across all topics
  // ═══════════════════════════════════════════════════════════════════════════

  // ── Psychiatry ────────────────────────────────────────────────────────────
  clinical_psychiatry: { recallCount: 0, appCount: 0, fcCount: 0, maxDaysAgo: 60 },
  psychopharmacology:  { recallCount: 0, appCount: 0, fcCount: 0, maxDaysAgo: 60 },
  psychotherapy:       { recallCount: 0, appCount: 0, fcCount: 0, maxDaysAgo: 60 },

  // ── Orthopaedics ──────────────────────────────────────────────────────────
  fractures_ortho:     { recallCount: 0, appCount: 0, fcCount: 0, maxDaysAgo: 60 },
  joint_disorders:     { recallCount: 0, appCount: 0, fcCount: 0, maxDaysAgo: 60 },
  spinal_disorders:    { recallCount: 0, appCount: 0, fcCount: 0, maxDaysAgo: 60 },

  // ── Radiology ─────────────────────────────────────────────────────────────
  basic_radiology:     { recallCount: 0, appCount: 0, fcCount: 0, maxDaysAgo: 60 },
  ct_mri:              { recallCount: 0, appCount: 0, fcCount: 0, maxDaysAgo: 60 },
  interventional_rad:  { recallCount: 0, appCount: 0, fcCount: 0, maxDaysAgo: 60 },

  // ── Anaesthesiology ───────────────────────────────────────────────────────
  general_anaes:       { recallCount: 0, appCount: 0, fcCount: 0, maxDaysAgo: 60 },
  regional_anaes:      { recallCount: 0, appCount: 0, fcCount: 0, maxDaysAgo: 60 },
  pain_management:     { recallCount: 0, appCount: 0, fcCount: 0, maxDaysAgo: 60 },
};

// ── Generate all seed data ────────────────────────────────────────────────────
function buildSeedData() {
  const allAttempts   = [];
  const allFcResponses = [];

  for (const [topicKey, topic] of Object.entries(TOPICS)) {
    const config = SEED_CONFIGS[topicKey];
    if (!config) continue;
    const { attempts, fcResponses } = generateAttempts(
      topic.id, topic.subject_id, config
    );
    allAttempts.push(...attempts);
    allFcResponses.push(...fcResponses);
  }

  return { attempts: allAttempts, fcResponses: allFcResponses };
}

const TOPIC_INDEX = Object.values(TOPICS).map(t => ({
  topic_id: t.id, subject_id: t.subject_id,
}));

// ── Run and export ────────────────────────────────────────────────────────────
const { attempts: SEED_ATTEMPTS, fcResponses: SEED_FC } = buildSeedData();
const READINESS = computeReadiness(SEED_ATTEMPTS, SEED_FC, TOPIC_INDEX);

// Expose globally for the wireframe
if (typeof window !== 'undefined') {
  window.ReadinessEngine = {
    SUBJECTS, TOPICS,
    SEED_ATTEMPTS, SEED_FC,
    READINESS,
    computeReadiness,
    computeTopicMastery,
    computeSubjectMastery,
  };
}

// Node.js export
if (typeof module !== 'undefined') {
  module.exports = {
    SUBJECTS, TOPICS,
    SEED_ATTEMPTS, SEED_FC,
    READINESS,
    computeReadiness,
    computeTopicMastery,
    computeSubjectMastery,
    THRESHOLDS,
  };
}
