const { expect } = require('chai');
const { validateMapping } = require('../src/validation');

describe('validateMapping', () => {
  it('accepts a valid mapping', () => {
    const result = validateMapping({
      email: { destField: 'email', type: 'string', required: true },
      age: { destField: 'age', type: 'number' },
    });
    expect(result.valid).to.equal(true);
    expect(result.errors).to.deep.equal([]);
  });

  it('rejects non-object input', () => {
    expect(validateMapping(null).valid).to.equal(false);
    expect(validateMapping([]).valid).to.equal(false);
    expect(validateMapping('nope').valid).to.equal(false);
  });

  it('rejects an empty mapping', () => {
    const result = validateMapping({});
    expect(result.valid).to.equal(false);
    expect(result.errors[0].message).to.match(/at least one column/);
  });

  it('requires destField on each entry', () => {
    const result = validateMapping({ name: { type: 'string' } });
    expect(result.valid).to.equal(false);
    expect(result.errors).to.deep.include({ field: 'name', message: 'destField is required' });
  });

  it('flags duplicate destination fields', () => {
    const result = validateMapping({
      a: { destField: 'email' },
      b: { destField: 'email' },
    });
    expect(result.valid).to.equal(false);
    expect(result.errors[0].message).to.match(/Duplicate destination field "email"/);
  });

  it('rejects unknown types', () => {
    const result = validateMapping({ n: { destField: 'n', type: 'float' } });
    expect(result.valid).to.equal(false);
    expect(result.errors[0].message).to.match(/Invalid type "float"/);
  });

  it('flags source columns missing from the CSV header', () => {
    const result = validateMapping(
      { ghost: { destField: 'g' } },
      { columns: ['real'] }
    );
    expect(result.valid).to.equal(false);
    expect(result.errors[0].message).to.match(/Unknown source column "ghost"/);
  });

  it('reports unmapped required destination fields', () => {
    const result = validateMapping(
      { name: { destField: 'name' } },
      { requiredFields: ['email'] }
    );
    expect(result.valid).to.equal(false);
    expect(result.errors[0].message).to.match(/Required destination field "email" is not mapped/);
  });
});
