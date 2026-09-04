'use strict';

const assert = require('assert');
const AdmZip = require('adm-zip');
const { generateAnswerSheet } = require('./answer-sheet-generator');

async function run() {
  const generated = await generateAnswerSheet({ classroomName: 'QA Classroom' });
  const zip = new AdmZip(generated.buffer);
  const documentXml = zip.readAsText('word/document.xml');
  const relationshipsXml = zip.readAsText('word/_rels/document.xml.rels');
  const count = value => documentXml.split(value).length - 1;

  assert.strictEqual(generated.copiesUpdated, 2, 'both printable copies must be updated');
  assert.strictEqual(count('STUDENT SEQUENCE NO.'), 2, 'each copy needs one sequence label');
  assert.strictEqual(count('<w:tblW w:w="860" w:type="dxa"/>'), 2, 'each copy needs one two-box table');
  assert.strictEqual(count('<w:tcW w:w="430" w:type="dxa"/>'), 4, 'two copies must contain four boxes total');
  assert.ok(documentXml.includes('QA Classroom'), 'the classroom label must be inserted');
  assert.ok(!/answer-key-qr|AcadCheck Answer Key QR/i.test(documentXml), 'the document must not contain a QR drawing');
  assert.ok(!/answer-key-qr/i.test(relationshipsXml), 'the document must not contain a QR relationship');
  assert.deepStrictEqual(
    zip.getEntries().map(entry => entry.entryName).filter(name => /answer-key-qr/i.test(name)),
    [],
    'the DOCX must not contain QR media'
  );

  console.log(JSON.stringify({ success: true, copies: 2, sequenceBoxesPerCopy: 2, qrMedia: 0 }));
}

run().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
