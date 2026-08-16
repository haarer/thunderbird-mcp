/**
 * Validation tests for the read-only MCP server.
 *
 * The validation function runs inside the Thunderbird extension context, so
 * tool schemas and validateAgainstSchema are VM-extracted from the marked
 * sections of production api.js. These tests cannot drift from the schemas
 * the extension actually exposes.
 *
 * Covers:
 * - searchMessages tag filter, dedupByMessageId, pagination
 * - getMessages batch caps
 * - getAccountAccess
 * - getMessage inline images
 * - Validator engine: enum, oneOf, integer
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const apiSource = fs.readFileSync(
  path.resolve(__dirname, '../extension/mcp_server/api.js'),
  'utf8'
);

function getMarkedApiSnippet(startMarker, endMarker) {
  const start = apiSource.indexOf(startMarker);
  const end = apiSource.indexOf(endMarker, start + startMarker.length);
  assert.ok(start >= 0, `api.js marker missing: ${startMarker}`);
  assert.ok(end > start, `api.js marker missing: ${endMarker}`);
  return apiSource.slice(start, end);
}

function loadProductionValidator() {
  const sandbox = {
    getConfiguredGetMessagesLimit: () => 20,
  };
  vm.createContext(sandbox);
  vm.runInContext([
    getMarkedApiSnippet('// BEGIN TOOL SCHEMA BUILDER', '// END TOOL SCHEMA BUILDER'),
    getMarkedApiSnippet('// BEGIN TOOL SCHEMA VALIDATOR', '// END TOOL SCHEMA VALIDATOR'),
    'this.buildTools = buildTools;',
    'this.validateAgainstSchema = validateAgainstSchema;',
  ].join('\n'), sandbox);
  return sandbox;
}

const production = loadProductionValidator();

function validateProductionToolArgs(name, args) {
  const tool = production.buildTools().find(t => t.name === name);
  assert.ok(tool, `production tool schema missing: ${name}`);
  const schema = tool.inputSchema;
  const errors = [];
  for (const key of schema.required || []) {
    if (args[key] === undefined || args[key] === null) {
      errors.push(`Missing required parameter: ${key}`);
    }
  }
  for (const [key, value] of Object.entries(args)) {
    const propSchema = schema.properties?.[key];
    if (!propSchema) {
      errors.push(`Unknown parameter: ${key}`);
      continue;
    }
    production.validateAgainstSchema(value, propSchema, key, errors);
    if (propSchema.type === 'array' && Array.isArray(value)) {
      if (propSchema.minItems !== undefined && value.length < propSchema.minItems) {
        errors.push(`Parameter '${key}' must contain at least ${propSchema.minItems} item(s)`);
      }
      if (propSchema.maxItems !== undefined && value.length > propSchema.maxItems) {
        errors.push(`Parameter '${key}' must contain at most ${propSchema.maxItems} item(s)`);
      }
    }
  }
  return errors;
}

const validate = validateProductionToolArgs;

/**
 * Harness for validator-engine tests. Uses the production validateAgainstSchema
 * (VM-extracted) against synthetic schemas, so engine behavior is exercised
 * without depending on any specific production tool.
 */
function createValidator(tools) {
  const toolSchemas = Object.create(null);
  for (const t of tools) {
    toolSchemas[t.name] = t.inputSchema;
  }

  return function validateToolArgs(name, args) {
    const schema = toolSchemas[name];
    if (!schema) return [`Unknown tool: ${name}`];

    const errors = [];
    for (const key of schema.required || []) {
      if (args[key] === undefined || args[key] === null) {
        errors.push(`Missing required parameter: ${key}`);
      }
    }
    for (const [key, value] of Object.entries(args)) {
      const propSchema = Object.prototype.hasOwnProperty.call(schema.properties || {}, key)
        ? schema.properties[key]
        : undefined;
      if (!propSchema) {
        errors.push(`Unknown parameter: ${key}`);
        continue;
      }
      if (value === undefined || value === null) continue;
      production.validateAgainstSchema(value, propSchema, key, errors);
    }
    return errors;
  };
}

const richValidator = createValidator([
  {
    name: 'getMessage',
    inputSchema: {
      type: 'object',
      properties: {
        messageId: { type: 'string' },
        folderPath: { type: 'string' },
        bodyFormat: { type: 'string', enum: ['markdown', 'text', 'html'] },
        rawSource: { type: 'boolean' },
        includeInlineImages: { type: 'boolean' },
      },
      required: ['messageId', 'folderPath'],
    },
  },
  {
    name: 'exampleSend',
    inputSchema: {
      type: 'object',
      properties: {
        to: { type: 'string' },
        subject: { type: 'string' },
        body: { type: 'string' },
        attachments: {
          type: 'array',
          items: {
            oneOf: [
              { type: 'string' },
              {
                type: 'object',
                properties: {
                  name: { type: 'string' },
                  contentType: { type: 'string' },
                  base64: { type: 'string' },
                },
                required: ['name', 'base64'],
                additionalProperties: false,
              },
            ],
          },
        },
      },
      required: ['to', 'subject', 'body'],
    },
  },
  {
    name: 'exampleTask',
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string' },
        priority: { type: 'integer' },
      },
      required: ['title'],
    },
  },
]);

describe('Validation: searchMessages', () => {
  it('accepts tag filter as string in searchMessages', () => {
    const errors = validate('searchMessages', {
      query: 'test',
      tag: '$label1',
    });
    assert.equal(errors.length, 0);
  });

  it('rejects tag filter as number in searchMessages', () => {
    const errors = validate('searchMessages', {
      query: 'test',
      tag: 42,
    });
    assert.equal(errors.length, 1);
    assert.match(errors[0], /must be string/);
  });

  it('accepts dedupByMessageId as boolean in searchMessages', () => {
    const errors = validate('searchMessages', {
      query: 'test',
      dedupByMessageId: false,
    });
    assert.equal(errors.length, 0);
  });

  it('rejects dedupByMessageId as non-boolean', () => {
    const errors = validate('searchMessages', {
      query: 'test',
      dedupByMessageId: 'yes',
    });
    assert.equal(errors.length, 1);
    assert.match(errors[0], /must be boolean/);
  });
});

describe('Validation: pagination parameters', () => {
  it('accepts offset as number', () => {
    const errors = validate('searchMessages', {
      query: 'test',
      offset: 50,
    });
    assert.equal(errors.length, 0);
  });

  it('rejects offset as string', () => {
    const errors = validate('searchMessages', {
      query: 'test',
      offset: 'fifty',
    });
    assert.equal(errors.length, 1);
    assert.match(errors[0], /must be number/);
  });

  it('accepts offset=0', () => {
    const errors = validate('searchMessages', {
      query: 'test',
      offset: 0,
    });
    assert.equal(errors.length, 0);
  });

  it('accepts offset with maxResults', () => {
    const errors = validate('searchMessages', {
      query: 'test',
      offset: 100,
      maxResults: 50,
    });
    assert.equal(errors.length, 0);
  });
});

describe('Validation: account access control', () => {
  it('getAccountAccess accepts no params', () => {
    const errors = validate('getAccountAccess', {});
    assert.equal(errors.length, 0);
  });

  it('getAccountAccess rejects unknown params', () => {
    const errors = validate('getAccountAccess', { bogus: 'value' });
    assert.equal(errors.length, 1);
    assert.match(errors[0], /Unknown parameter/);
  });
});

describe('Validation: getMessages batch size', () => {
  const messageRef = { messageId: "message-1", folderPath: "imap://user@server/INBOX" };

  it('accepts messages at the configured cap', () => {
    const errors = validate('getMessages', {
      messages: Array.from({ length: 20 }, (_, index) => ({
        ...messageRef,
        messageId: `message-${index}`,
      })),
    });
    assert.deepStrictEqual(errors, []);
  });

  it('rejects empty messages arrays', () => {
    const errors = validate('getMessages', { messages: [] });
    assert.equal(errors.length, 1);
    assert.match(errors[0], /at least 1/);
  });

  it('rejects messages arrays over the configured cap', () => {
    const errors = validate('getMessages', {
      messages: Array.from({ length: 21 }, (_, index) => ({
        ...messageRef,
        messageId: `message-${index}`,
      })),
    });
    assert.equal(errors.length, 1);
    assert.match(errors[0], /at most 20/);
  });

  it('rejects messages items with unknown properties', () => {
    const errors = validate('getMessages', {
      messages: [{ ...messageRef, evil: true }],
    });
    assert.ok(errors.length >= 1);
    assert.match(errors[0], /Unknown parameter/);
  });
});

describe('Validator: enum enforcement', () => {
  it('accepts an enum value that is in the list', () => {
    const errors = richValidator('getMessage', {
      messageId: 'm-1',
      folderPath: 'imap://x/INBOX',
      bodyFormat: 'markdown',
    });
    assert.equal(errors.length, 0);
  });

  it('rejects an enum value that is not in the list', () => {
    const errors = richValidator('getMessage', {
      messageId: 'm-1',
      folderPath: 'imap://x/INBOX',
      bodyFormat: 'docx',
    });
    assert.equal(errors.length, 1);
    assert.match(errors[0], /must be one of/);
    assert.match(errors[0], /bodyFormat/);
  });

  it('enum check still rejects when string type is satisfied but value is off-list', () => {
    const errors = richValidator('getMessage', {
      messageId: 'm-1',
      folderPath: 'imap://x/INBOX',
      bodyFormat: 'Markdown', // wrong case
    });
    assert.equal(errors.length, 1);
    assert.match(errors[0], /must be one of/);
  });
});

describe('Validator: getMessage inline images', () => {
  it('accepts includeInlineImages as a boolean', () => {
    const errors = validate('getMessage', {
      messageId: 'm-1',
      folderPath: 'imap://x/INBOX',
      includeInlineImages: true,
    });
    assert.equal(errors.length, 0);
  });

  it('rejects non-boolean includeInlineImages values', () => {
    const errors = validate('getMessage', {
      messageId: 'm-1',
      folderPath: 'imap://x/INBOX',
      includeInlineImages: 'yes',
    });
    assert.equal(errors.length, 1);
    assert.match(errors[0], /includeInlineImages/);
    assert.match(errors[0], /must be boolean/);
  });
});

describe('Validator: oneOf items', () => {
  it('accepts pure string variants', () => {
    const errors = richValidator('exampleSend', {
      to: 'a@b.c',
      subject: 's',
      body: 'b',
      attachments: ['/tmp/a.txt', '/tmp/b.pdf'],
    });
    assert.equal(errors.length, 0);
  });

  it('accepts well-formed object variants', () => {
    const errors = richValidator('exampleSend', {
      to: 'a@b.c',
      subject: 's',
      body: 'b',
      attachments: [{ name: 'a.txt', base64: 'aGk=' }],
    });
    assert.equal(errors.length, 0);
  });

  it('rejects objects missing required fields', () => {
    const errors = richValidator('exampleSend', {
      to: 'a@b.c',
      subject: 's',
      body: 'b',
      attachments: [{ contentType: 'application/pdf' }],
    });
    // both branches fail (string branch on type, object branch on missing
    // required), so oneOf records "did not match any allowed variant"
    assert.ok(errors.some(e => /did not match any allowed schema variant/.test(e)),
      `expected oneOf failure, got: ${JSON.stringify(errors)}`);
  });

  it('rejects objects with extra properties (additionalProperties:false)', () => {
    const errors = richValidator('exampleSend', {
      to: 'a@b.c',
      subject: 's',
      body: 'b',
      attachments: [{ name: 'a.txt', base64: 'aGk=', evil: '../../../etc/passwd' }],
    });
    assert.ok(errors.some(e => /did not match any allowed schema variant/.test(e)),
      `expected oneOf failure when extra props present, got: ${JSON.stringify(errors)}`);
  });

  it('rejects array entries that are neither strings nor valid objects (e.g. numbers)', () => {
    const errors = richValidator('exampleSend', {
      to: 'a@b.c',
      subject: 's',
      body: 'b',
      attachments: [123],
    });
    assert.ok(errors.some(e => /did not match any allowed schema variant/.test(e)));
  });

  it('flags the failing index in the error path', () => {
    const errors = richValidator('exampleSend', {
      to: 'a@b.c',
      subject: 's',
      body: 'b',
      attachments: ['/tmp/ok.txt', 123, '/tmp/also-ok.txt'],
    });
    assert.ok(errors.some(e => /attachments\[1\]/.test(e)),
      `expected attachments[1] path, got: ${JSON.stringify(errors)}`);
  });
});

describe('Validator: integer type', () => {
  it('accepts whole numbers for integer fields', () => {
    const errors = richValidator('exampleTask', { title: 't', priority: 5 });
    assert.equal(errors.length, 0);
  });

  it('rejects floats for integer fields', () => {
    const errors = richValidator('exampleTask', { title: 't', priority: 1.5 });
    assert.equal(errors.length, 1);
    assert.match(errors[0], /must be an integer/);
  });

  it('rejects numeric strings for integer fields (no auto-coerce here)', () => {
    const errors = richValidator('exampleTask', { title: 't', priority: '5' });
    assert.equal(errors.length, 1);
    assert.match(errors[0], /must be an integer/);
  });
});
