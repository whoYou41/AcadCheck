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

function qrRun(relationshipId, drawingId) {
  const size = 720000; // 0.79 inch; fills the template's original bottom cube.
  return `<w:r><w:drawing>
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
    </w:drawing></w:r>`;
}

function sequenceDigitCell() {
  return `<w:tc>
    <w:tcPr>
      <w:tcW w:w="430" w:type="dxa"/>
      <w:tcBorders>
        <w:top w:val="single" w:sz="10" w:space="0" w:color="000000"/>
        <w:left w:val="single" w:sz="10" w:space="0" w:color="000000"/>
        <w:bottom w:val="single" w:sz="10" w:space="0" w:color="000000"/>
        <w:right w:val="single" w:sz="10" w:space="0" w:color="000000"/>
      </w:tcBorders>
      <w:vAlign w:val="center"/>
    </w:tcPr>
    <w:p>
      <w:pPr>
        <w:spacing w:before="0" w:after="0" w:line="480" w:lineRule="exact"/>
        <w:jc w:val="center"/>
      </w:pPr>
    </w:p>
  </w:tc>`;
}

function answerIdentityTable(relationshipId, drawingId) {
  const digitCells = Array.from({ length: 4 }, () => sequenceDigitCell()).join('');
  return `<w:tbl>
    <w:tblPr>
      <w:tblW w:w="3500" w:type="dxa"/>
      <w:jc w:val="center"/>
      <w:tblLayout w:type="fixed"/>
      <w:tblCellMar>
        <w:top w:w="20" w:type="dxa"/>
        <w:left w:w="30" w:type="dxa"/>
        <w:bottom w:w="20" w:type="dxa"/>
        <w:right w:w="30" w:type="dxa"/>
      </w:tblCellMar>
    </w:tblPr>
    <w:tblGrid>
      <w:gridCol w:w="1250"/>
      <w:gridCol w:w="2250"/>
    </w:tblGrid>
    <w:tr>
      <w:trPr><w:trHeight w:val="1200" w:hRule="exact"/></w:trPr>
      <w:tc>
        <w:tcPr>
          <w:tcW w:w="1250" w:type="dxa"/>
          <w:tcBorders>
            <w:top w:val="single" w:sz="10" w:space="0" w:color="000000"/>
            <w:left w:val="single" w:sz="10" w:space="0" w:color="000000"/>
            <w:bottom w:val="single" w:sz="10" w:space="0" w:color="000000"/>
            <w:right w:val="single" w:sz="10" w:space="0" w:color="000000"/>
          </w:tcBorders>
          <w:vAlign w:val="center"/>
        </w:tcPr>
        <w:p>
          <w:pPr>
            <w:spacing w:before="0" w:after="0"/>
            <w:jc w:val="center"/>
          </w:pPr>
          ${qrRun(relationshipId, drawingId)}
        </w:p>
      </w:tc>
      <w:tc>
        <w:tcPr>
          <w:tcW w:w="2250" w:type="dxa"/>
          <w:tcMar>
            <w:top w:w="50" w:type="dxa"/>
            <w:left w:w="140" w:type="dxa"/>
            <w:bottom w:w="20" w:type="dxa"/>
            <w:right w:w="30" w:type="dxa"/>
          </w:tcMar>
          <w:vAlign w:val="center"/>
        </w:tcPr>
        <w:p>
          <w:pPr>
            <w:spacing w:before="0" w:after="40"/>
            <w:jc w:val="center"/>
          </w:pPr>
          <w:r>
            <w:rPr>
              <w:rFonts w:ascii="Arial" w:hAnsi="Arial"/>
              <w:b/>
              <w:sz w:val="16"/>
            </w:rPr>
            <w:t>STUDENT SEQUENCE NO.</w:t>
          </w:r>
        </w:p>
        <w:tbl>
          <w:tblPr>
            <w:tblW w:w="1720" w:type="dxa"/>
            <w:jc w:val="center"/>
            <w:tblLayout w:type="fixed"/>
          </w:tblPr>
          <w:tblGrid>
            <w:gridCol w:w="430"/>
            <w:gridCol w:w="430"/>
            <w:gridCol w:w="430"/>
            <w:gridCol w:w="430"/>
          </w:tblGrid>
          <w:tr>
            <w:trPr><w:trHeight w:val="520" w:hRule="exact"/></w:trPr>
            ${digitCells}
          </w:tr>
        </w:tbl>
        <w:p/>
      </w:tc>
    </w:tr>
  </w:tbl>`;
}

async function generateAnswerSheet({ classroomName, answerKeyId, qrToken }) {
  if (!fs.existsSync(TEMPLATE_PATH)) {
    throw new Error('Answer sheet template is missing');
  }
  if (!answerKeyId || !qrToken) {
    throw new Error('Answer key QR identity is incomplete');
  }

  // Keep the printed code sparse enough for a sub-inch camera target. The
  // database still stores the full random token; only its binary form is
  // encoded more compactly. The detector accepts all older payloads.
  if (!/^[a-f0-9]{32,64}$/i.test(qrToken) || qrToken.length % 2 !== 0) {
    throw new Error('Answer key QR token is invalid');
  }
  const compactToken = Buffer.from(qrToken, 'hex').toString('base64url');
  const payload = `AC1:${answerKeyId}:${compactToken}`;
  const qrBuffer = await QRCode.toBuffer(payload, {
    type: 'png',
    errorCorrectionLevel: 'Q',
    margin: 1,
    width: 600,
    color: { dark: '#000000', light: '#FFFFFF' },
  });

  const zip = new AdmZip(TEMPLATE_PATH);
  const documentEntry = zip.getEntry('word/document.xml');
  const relsEntry = zip.getEntry('word/_rels/document.xml.rels');
  const numberingEntry = zip.getEntry('word/numbering.xml');
  if (!documentEntry || !relsEntry || !numberingEntry) {
    throw new Error('Answer sheet template is not a valid DOCX file');
  }

  const relationshipId = 'rIdAcadCheckQr';
  let documentXml = documentEntry.getData().toString('utf8');
  let relsXml = relsEntry.getData().toString('utf8');
  let numberingXml = numberingEntry.getData().toString('utf8');
  documentXml = documentXml.replace(
    '<w:document ',
    '<w:document xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture" '
  );
  documentXml = documentXml.replace(/<w:t>--Subject--<\/w:t>/g, `<w:t>${escapeXml(classroomName)}</w:t>`);

  // The source template reuses the same two numbering instances across both
  // side-by-side copies, causing copy two to continue as 26..75. Give the
  // second copy fresh numbering instances so both physical forms are 1..50.
  const firstCopyEnd = documentXml.indexOf('---End of the ');
  if (firstCopyEnd < 0) {
    throw new Error('Could not find the first end-of-test marker in the answer-sheet template');
  }
  const secondCopyXml = documentXml.slice(firstCopyEnd)
    .replace(/<w:numId w:val="1"\/>/g, '<w:numId w:val="6"/>')
    .replace(/<w:numId w:val="2"\/>/g, '<w:numId w:val="7"/>');
  documentXml = documentXml.slice(0, firstCopyEnd) + secondCopyXml;
  numberingXml = numberingXml.replace(
    '</w:numbering>',
    '<w:num w:numId="6"><w:abstractNumId w:val="3"/>'
      + '<w:lvlOverride w:ilvl="0"><w:startOverride w:val="1"/></w:lvlOverride></w:num>'
      + '<w:num w:numId="7"><w:abstractNumId w:val="4"/>'
      + '<w:lvlOverride w:ilvl="0"><w:startOverride w:val="26"/></w:lvlOverride></w:num>'
      + '</w:numbering>'
  );

  let drawingId = 9100;
  // Each copy has a floating placeholder rectangle followed by five empty
  // spacer paragraphs immediately before its end-of-test marker. Replace that
  // complete reserved region with one fixed QR + handwritten sequence table.
  // Replacements run backwards so XML offsets for the first copy stay valid.
  const endMarkers = [];
  const markerPattern = /---End of the [\s\S]*?Test---/g;
  let markerMatch;
  while ((markerMatch = markerPattern.exec(documentXml)) !== null) {
    endMarkers.push(markerMatch.index);
  }
  let insertedCount = 0;
  for (let index = endMarkers.length - 1; index >= 0; index--) {
    const markerIndex = endMarkers[index];
    const endParagraphStart = documentXml.lastIndexOf('<w:p ', markerIndex);
    const rectangleIndex = documentXml.lastIndexOf('id="Rectangle 407"', endParagraphStart);
    const reservedStart = rectangleIndex >= 0
      ? documentXml.lastIndexOf('<w:p ', rectangleIndex)
      : -1;
    if (reservedStart < 0 || endParagraphStart < 0 || endParagraphStart - reservedStart > 12000) {
      continue;
    }
    const reservedXml = documentXml.slice(reservedStart, endParagraphStart);
    if (!reservedXml.includes('id="Rectangle 407"')) continue;
    insertedCount++;
    drawingId++;
    documentXml = documentXml.slice(0, reservedStart)
      + answerIdentityTable(relationshipId, drawingId)
      + documentXml.slice(endParagraphStart);
  }
  if (insertedCount !== 2) {
    throw new Error(`Expected two reserved QR/sequence regions in the answer-sheet template; found ${insertedCount}`);
  }

  relsXml = relsXml.replace(
    '</Relationships>',
    `<Relationship Id="${relationshipId}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/answer-key-qr.png"/></Relationships>`
  );

  zip.updateFile('word/document.xml', Buffer.from(documentXml, 'utf8'));
  zip.updateFile('word/_rels/document.xml.rels', Buffer.from(relsXml, 'utf8'));
  zip.updateFile('word/numbering.xml', Buffer.from(numberingXml, 'utf8'));
  zip.addFile('word/media/answer-key-qr.png', qrBuffer);

  return {
    buffer: zip.toBuffer(),
    payload,
    copiesUpdated: insertedCount,
  };
}

module.exports = { generateAnswerSheet, TEMPLATE_PATH };
