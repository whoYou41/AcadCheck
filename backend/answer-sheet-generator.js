const fs = require('fs');
const path = require('path');
const AdmZip = require('adm-zip');
const QRCode = require('qrcode');

const TEMPLATE_PATH = path.join(__dirname, 'templates', 'Answer-Sheet.docx');

function escapeXml(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function qrParagraph(relationshipId, drawingId) {
  const size = 914400; // 1 inch square
  return `<w:p>
    <w:pPr><w:jc w:val="center"/><w:spacing w:after="0"/></w:pPr>
    <w:r><w:drawing>
      <wp:inline distT="0" distB="0" distL="0" distR="0">
        <wp:extent cx="${size}" cy="${size}"/>
        <wp:effectExtent l="0" t="0" r="0" b="0"/>
        <wp:docPr id="${drawingId}" name="AcadCheck Answer Key QR"/>
        <wp:cNvGraphicFramePr><a:graphicFrameLocks noChangeAspect="1"/></wp:cNvGraphicFramePr>
        <a:graphic>
          <a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture">
            <pic:pic>
              <pic:nvPicPr>
                <pic:cNvPr id="${drawingId}" name="answer-key-qr.png"/>
                <pic:cNvPicPr/>
              </pic:nvPicPr>
              <pic:blipFill>
                <a:blip r:embed="${relationshipId}"/>
                <a:stretch><a:fillRect/></a:stretch>
              </pic:blipFill>
              <pic:spPr>
                <a:xfrm><a:off x="0" y="0"/><a:ext cx="${size}" cy="${size}"/></a:xfrm>
                <a:prstGeom prst="rect"><a:avLst/></a:prstGeom>
              </pic:spPr>
            </pic:pic>
          </a:graphicData>
        </a:graphic>
      </wp:inline>
    </w:drawing></w:r>
  </w:p>`;
}

async function generateAnswerSheet({ classroomName, answerKeyId, qrToken }) {
  if (!fs.existsSync(TEMPLATE_PATH)) {
    throw new Error('Answer sheet template is missing');
  }
  if (!answerKeyId || !qrToken) {
    throw new Error('Answer key QR identity is incomplete');
  }

  // Layout metadata makes the QR/form contract explicit. The detector still
  // accepts legacy ID/token payloads so already printed sheets keep working.
  const payload = `ACADCHECK:ANSWER_KEY:V1:50:4:${answerKeyId}:${qrToken}`;
  const qrBuffer = await QRCode.toBuffer(payload, {
    type: 'png',
    errorCorrectionLevel: 'H',
    margin: 1,
    width: 420,
    color: { dark: '#000000', light: '#FFFFFF' },
  });

  const zip = new AdmZip(TEMPLATE_PATH);
  const documentEntry = zip.getEntry('word/document.xml');
  const relsEntry = zip.getEntry('word/_rels/document.xml.rels');
  if (!documentEntry || !relsEntry) {
    throw new Error('Answer sheet template is not a valid DOCX file');
  }

  const relationshipId = 'rIdAcadCheckQr';
  let documentXml = documentEntry.getData().toString('utf8');
  let relsXml = relsEntry.getData().toString('utf8');
  documentXml = documentXml.replace(
    '<w:document ',
    '<w:document xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture" '
  );
  documentXml = documentXml.replace(/<w:t>--Subject--<\/w:t>/g, `<w:t>${escapeXml(classroomName)}</w:t>`);

  let drawingId = 9100;
  // The supplied two-up template reserves each bottom cube as five empty
  // fixed-height paragraphs immediately after the end-of-test text. Replace
  // that reserved slot instead of appending another inch and changing the
  // document's page flow.
  const qrSlot = /(<w:p\b(?:(?!<w:p\b)[\s\S])*?---End of the (?:(?!<\/w:p>)[\s\S])*?Test---(?:(?!<\/w:p>)[\s\S])*?<\/w:p>)((?:<w:p\b(?:(?!<w:p\b)[\s\S])*?<\/w:p>){5})/g;
  let insertedCount = 0;
  documentXml = documentXml.replace(qrSlot, (match, endParagraph, blankSlot) => {
    if (/<w:t\b|<w:drawing\b|<w:pict\b/.test(blankSlot)) {
      return match;
    }
    insertedCount++;
    drawingId++;
    return `${endParagraph}${qrParagraph(relationshipId, drawingId)}`;
  });
  if (insertedCount !== 2) {
    throw new Error(`Expected two reserved QR slots in the answer-sheet template; found ${insertedCount}`);
  }

  relsXml = relsXml.replace(
    '</Relationships>',
    `<Relationship Id="${relationshipId}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/answer-key-qr.png"/></Relationships>`
  );

  zip.updateFile('word/document.xml', Buffer.from(documentXml, 'utf8'));
  zip.updateFile('word/_rels/document.xml.rels', Buffer.from(relsXml, 'utf8'));
  zip.addFile('word/media/answer-key-qr.png', qrBuffer);

  return {
    buffer: zip.toBuffer(),
    payload,
    copiesUpdated: insertedCount,
  };
}

module.exports = { generateAnswerSheet, TEMPLATE_PATH };
