import { defineAgent, defineDynamic } from 'eve';

function localModel() {
  const modelId = process.env.LOCCA_MODEL_ID;
  if (!modelId) throw new Error('Start this agent with locca agent.');
  return {
    model: `locca/${modelId}`,
    modelContextWindowTokens: Number(process.env.LOCCA_CONTEXT_WINDOW) || 8192,
  };
}

export default defineAgent({
  defaultTools: false,
  model: defineDynamic({
    events: { 'session.started': localModel, 'turn.started': localModel },
  }),
  compaction: { thresholdPercent: 0.7 },
  limits: { maxInputTokensPerSession: 500_000, maxOutputTokensPerSession: 50_000 },
});
