import { parseStudentName } from './student-name';
import { escapePrintText } from './document-print';
describe('Bulk student names', () => {
  it('preserves a two-word first name and separates the dotted initial', () => {
    expect(parseStudentName('John Reelan E. Altobar')).toEqual({firstName:'John Reelan',middleName:'E.',lastName:'Altobar',error:''});
  });
  it('accepts one or several given names and normalizes whitespace and initials', () => {
    expect(parseStudentName('  Maria   Clara r. Santos ').firstName).toBe('Maria Clara');
    expect(parseStudentName('  Maria   Clara r. Santos ').middleName).toBe('R.');
    expect(parseStudentName('John E. Altobar').error).toBe('');
  });
  it('rejects ambiguous names instead of putting given names into the middle field', () => {
    for(const name of ['John Reelan Altobar','John E Altobar','John E.','E. Altobar','John E. Dela Cruz'])
      expect(parseStudentName(name).error).not.toBe('');
  });
  it('escapes roster text before putting it in the print document', () => {
    expect(escapePrintText('<script>&"')).toBe('&lt;script&gt;&amp;&quot;');
  });
});
