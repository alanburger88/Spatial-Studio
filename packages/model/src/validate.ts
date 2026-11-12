import { fieldIndex } from './fields';
import type { DocumentType, Predicate, Project, Rule } from './types';

const COMPARE = new Set(['eq', 'ne', 'gt', 'gte', 'lt', 'lte']);
const NUMERIC = new Set(['cents', 'int', 'points']);

/** Validates a typed rule expression: allowlisted operators, known paths and type-compatible values. */
export function validatePredicate(p: Predicate, documentType: DocumentType, depth = 0): string[] {
  const errors: string[] = [];
  if (depth > 8) return ['Expression nesting too deep (max 8).'];
  if (!p || typeof p !== 'object' || typeof (p as any).op !== 'string') return ['Expression must be an object with an op.'];
  const fields = fieldIndex(documentType);
  switch (p.op) {
    case 'and':
    case 'or':
      if (!Array.isArray(p.args) || p.args.length < 1) return [`${p.op} needs at least one argument.`];
      p.args.forEach((a) => errors.push(...validatePredicate(a, documentType, depth + 1)));
      return errors;
    case 'not':
      return validatePredicate(p.arg, documentType, depth + 1);
    case 'isNull':
    case 'notNull':
      if (!fields.has(p.path)) errors.push(`Unknown field path “${p.path}”.`);
      return errors;
    case 'in': {
      const f = fields.get(p.path);
      if (!f) return [`Unknown field path “${p.path}”.`];
      if (!Array.isArray(p.value)) return ['“in” requires a list of values.'];
      if (f.enumValues) for (const v of p.value) if (!f.enumValues.includes(String(v))) errors.push(`“${v}” is not a valid ${f.label} value.`);
      return errors;
    }
    default: {
      if (!COMPARE.has(p.op)) return [`Unsupported operator “${(p as any).op}”. Arbitrary code is not allowed.`];
      const f = fields.get((p as any).path);
      if (!f) return [`Unknown field path “${(p as any).path}”.`];
      const v = (p as any).value;
      if (NUMERIC.has(f.type) && (typeof v !== 'number' || !Number.isInteger(v))) errors.push(`${f.label} compares to an integer${f.type === 'cents' ? ' (cents)' : ''}.`);
      if (f.type === 'bool' && typeof v !== 'boolean') errors.push(`${f.label} compares to true/false.`);
      if (f.type === 'enum' && !f.enumValues!.includes(String(v))) errors.push(`“${v}” is not a valid ${f.label} value (${f.enumValues!.join(', ')}).`);
      if ((f.type === 'enum' || f.type === 'bool' || f.type === 'string') && ['gt', 'gte', 'lt', 'lte'].includes(p.op)) errors.push(`${p.op} is not valid for ${f.type} field ${f.label}.`);
      if (f.type === 'array') errors.push(`Use ${f.path}.count to compare a collection.`);
      return errors;
    }
  }
}

export function validateRule(rule: Rule, project: Project): string[] {
  const errors: string[] = [];
  if (!/^[A-Z][A-Z0-9-]{1,15}$/.test(rule.id)) errors.push('Rule ID must be uppercase letters/digits (e.g. R21).');
  if (rule.scope !== project.documentType) errors.push(`Rule scope must be ${project.documentType}.`);
  if (!['exclusive', 'additive', 'obligation'].includes(rule.mode)) errors.push('Mode must be exclusive, additive or obligation.');
  if (!Number.isInteger(rule.priority) || rule.priority < 0 || rule.priority > 10000) errors.push('Priority must be an integer 0–10000.');
  errors.push(...validatePredicate(rule.when, project.documentType));
  const nodes = new Map(project.nodes.map((n) => [n.id, n]));
  const parts = new Set(project.contentParts.map((c) => c.id));
  const a = rule.then;
  switch (a?.op) {
    case 'selectVariant': {
      const t = nodes.get(a.targetNodeId);
      if (!t || (t.type !== 'variant-set' && t.type !== 'conditional-region')) errors.push(`Target ${a.targetNodeId} is not a variant set / conditional region.`);
      else if (!t.variantIds?.includes(a.variantId)) errors.push(`Variant ${a.variantId} is not defined in ${a.targetNodeId}.`);
      if (rule.mode !== 'exclusive') errors.push('selectVariant requires exclusive mode.');
      if (rule.mode === 'exclusive' && rule.exclusiveGroup !== a.targetNodeId) errors.push('exclusiveGroup must equal the target node.');
      break;
    }
    case 'showSection':
      if (!nodes.has(a.targetNodeId) && !parts.has(a.targetNodeId)) errors.push(`Section ${a.targetNodeId} is neither a node nor a content part.`);
      if (rule.mode !== 'additive') errors.push('showSection requires additive mode.');
      break;
    case 'requireNodes':
      if (rule.mode !== 'obligation') errors.push('requireNodes requires obligation mode.');
      if (!Array.isArray(a.nodeIds) || !a.nodeIds.length) errors.push('requireNodes needs node IDs.');
      break;
    case 'setApprovedLocale':
      if (!['en-US', 'es-US'].includes(a.locale)) errors.push('Unsupported locale.');
      break;
    case 'setPresentationHint':
      if (!/^[a-z0-9-]{3,64}$/.test(a.hint)) errors.push('Presentation hint must be a kebab-case identifier.');
      break;
    default:
      errors.push('Unknown rule action.');
  }
  return errors;
}
