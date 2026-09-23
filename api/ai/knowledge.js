'use strict';

const fs = require('fs');
const path = require('path');

const candidates = [
  path.resolve(__dirname, '../../data/agent-knowledge.json'),
  path.resolve(__dirname, '../data/agent-knowledge.json')
];

function loadKnowledge() {
  const knowledgePath = candidates.find((candidate) => fs.existsSync(candidate));
  if (!knowledgePath) throw new Error('Approved agent knowledge file was not found.');

  const knowledge = JSON.parse(fs.readFileSync(knowledgePath, 'utf8'));
  if (!knowledge.business || !knowledge.agent_rules) {
    throw new Error('Approved agent knowledge is missing required sections.');
  }
  return Object.freeze(knowledge);
}

const knowledge = loadKnowledge();

function groundingContext() {
  // Only this allowlisted subset may leave the Rogernort backend. Internal
  // source notes and unresolved commercial questions stay server-side.
  const publicKnowledge = {
    business: {
      primary_service: knowledge.business.primary_service,
      phone: knowledge.business.phone,
      address: knowledge.business.address,
      office_hours: knowledge.business.office_hours
    },
    visa_assistance: knowledge.visa_assistance,
    holiday_packages: knowledge.holiday_packages,
    work_programmes: knowledge.work_programmes,
    work_abroad_process: knowledge.work_abroad_process,
    payments: knowledge.payments,
    agent_rules: knowledge.agent_rules
  };
  return JSON.stringify(publicKnowledge, null, 2);
}

module.exports = { knowledge, groundingContext };
