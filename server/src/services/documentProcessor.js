import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import yauzl from 'yauzl';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
import pdfParse from 'pdf-parse/lib/pdf-parse.js';
import XLSX from 'xlsx';
import ExcelJS from 'exceljs';
import { parse as parseCsv } from 'csv-parse/sync';
import { ExtractedRecord, Upload, SystemSetting } from '../models/index.js';
import { normalizePhone } from '../utils/contacts.js';

const execFileAsync = promisify(execFile);

const aliases = {
  name: ['name', 'employee name', 'name of employee', 'staff name', 'full name'],
  email: ['email', 'email address', 'e-mail', 'mail id'],
  phone: [
    'phone', 'mobile', 'mobile number', 'phone number',
    'contact number', 'contact'
  ],
  salaryAmount: [
    'salary', 'salary amount', 'net salary', 'net pay', 'salary paid',
    'pay amount', 'amount', 'amount inr', 'salary amount inr'
  ],
  salaryPeriod: [
    'salary period', 'salary month', 'pay period', 'effective date'
  ],
  language: ['language', 'preferred language']
};

const normalizeKey = value =>
  String(value ?? '')
    .replace(/^\uFEFF/, '')
    .trim()
    .toLowerCase()
    .replace(/[_-]+/g, ' ')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .replace(/\s+/g, ' ');

const normalizedAliases = Object.fromEntries(
  Object.entries(aliases).map(([field, names]) => [
    field,
    new Set(names.map(normalizeKey))
  ])
);

function mapRow(row) {
  const entries = Object.entries(row || {});
  const mapped = {};

  for (const [field, names] of Object.entries(normalizedAliases)) {
    const match = entries.find(([header]) =>
      names.has(normalizeKey(header))
    );

    if (match) {
      mapped[field] =
        match[1] == null ? '' : String(match[1]).trim();
    }
  }

  // Missing fields stay blank. Never shift another column's value into them.
  for (const field of Object.keys(normalizedAliases)) {
    if (mapped[field] === undefined) {
      mapped[field] = '';
    }
  }

  return mapped;
}

function parseTabularPdf(text) {
  const lines = String(text || '')
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(Boolean);

  const splitLine = line =>
    line.split(/\t+|\s{2,}|\s*\|\s*/).map(value => value.trim());

  let headerIndex = -1;
  let headers = [];

  for (let i = 0; i < Math.min(lines.length, 60); i++) {
    const cells = splitLine(lines[i]);
    const normalized = cells.map(normalizeKey);

    const hasName = normalized.some(value =>
      normalizedAliases.name.has(value)
    );

    const hasEmail = normalized.some(value =>
      normalizedAliases.email.has(value)
    );

    if (hasName && hasEmail) {
      headerIndex = i;
      headers = cells;
      break;
    }
  }

  if (headerIndex < 0) return [];

  return lines
    .slice(headerIndex + 1)
    .map(line => {
      const cells = splitLine(line);

      return Object.fromEntries(
        headers.map((header, index) => [
          header,
          cells[index] ?? ''
        ])
      );
    })
    .filter(row =>
      Object.values(row).some(value =>
        String(value ?? '').trim()
      )
    );
}

async function ocrPdf(filePath) {
  const temp = await fs.mkdtemp(
    path.join(os.tmpdir(), 'sggs-ocr-')
  );

  try {
    await execFileAsync(
      'pdftoppm',
      [
        '-f', '1',
        '-l', '30',
        '-png',
        '-r', '180',
        filePath,
        path.join(temp, 'page')
      ],
      {
        timeout: 90000,
        maxBuffer: 10 * 1024 * 1024
      }
    );

    const pages = (await fs.readdir(temp))
      .filter(name => name.endsWith('.png'))
      .sort((a, b) =>
        a.localeCompare(b, undefined, { numeric: true })
      )
      .slice(0, 30);

    if (!pages.length) {
      throw new Error(
        'Scanned PDF OCR needs Poppler pdftoppm installed on the server.'
      );
    }

    const language = process.env.OCR_LANGUAGES || 'eng+mar+hin';
    let text = '';

    for (const page of pages) {
      const { stdout } = await execFileAsync(
        process.env.TESSERACT_PATH || 'tesseract',
        [
          path.join(temp, page),
          'stdout',
          '-l',
          language,
          '--psm',
          '6'
        ],
        {
          timeout: 60000,
          maxBuffer: 5 * 1024 * 1024
        }
      );

      text += `\n${stdout}`;
    }

    return text;
  } catch (error) {
    if (error.code === 'ENOENT') {
      throw new Error(
        'OCR tools are not installed. Install Poppler (pdftoppm) and Tesseract with eng, mar and hin language packs.'
      );
    }

    throw error;
  } finally {
    await fs.rm(temp, {
      recursive: true,
      force: true
    }).catch(() => {});
  }
}

async function inspectZipArchive(filePath) {
  return new Promise((resolve, reject) => {
    yauzl.open(
      filePath,
      {
        lazyEntries: true,
        autoClose: true
      },
      (error, zip) => {
        if (error) return reject(error);

        let entries = 0;
        let uncompressed = 0;
        let rejected = false;

        const fail = message => {
          if (rejected) return;

          rejected = true;
          zip.close();
          reject(new Error(message));
        };

        zip.on('error', fail);

        zip.on('entry', entry => {
          entries += 1;
          uncompressed += Number(entry.uncompressedSize || 0);

          if (entries > 2000) {
            return fail('Workbook contains too many archive entries');
          }

          if (uncompressed > 100 * 1024 * 1024) {
            return fail('Workbook expands beyond the 100 MB safety limit');
          }

          if (
            Number(entry.compressedSize || 0) === 0 &&
            Number(entry.uncompressedSize || 0) > 1024 * 1024
          ) {
            return fail('Workbook contains a suspicious compressed entry');
          }

          if (
            Number(entry.compressedSize || 0) > 0 &&
            Number(entry.uncompressedSize || 0) /
              Number(entry.compressedSize || 0) > 1000
          ) {
            return fail('Workbook compression ratio exceeds the safety limit');
          }

          zip.readEntry();
        });

        zip.on('end', () => {
          if (!rejected) {
            resolve({
              entries,
              uncompressedBytes: uncompressed
            });
          }
        });

        zip.readEntry();
      }
    );
  });
}

function validateRecord(record) {
  const errors = [];

  if (!String(record.name || '').trim()) {
    errors.push('Missing employee name');
  }

  const email = String(record.email || '').trim();

  if (
    !email ||
    !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)
  ) {
    errors.push('Missing or invalid email address');
  }

  // Salary stays blank if it is absent from the source.
  // It is not populated from any unrelated CSV column.
  const amount = String(record.salaryAmount ?? '')
    .replace(/[₹,\s]/g, '');

  if (!amount) {
    errors.push('Missing salary amount');
  } else if (
    !Number.isFinite(Number(amount)) ||
    Number(amount) < 0
  ) {
    errors.push('Invalid salary amount');
  }

  // Email is assigned after administrator confirms the name match.
  return errors;
}

function cellValue(value) {
  if (value && typeof value === 'object') {
    if ('text' in value) return value.text;
    if ('result' in value) return value.result ?? '';

    if (Array.isArray(value.richText)) {
      return value.richText
        .map(part => part.text || '')
        .join('');
    }

    if ('hyperlink' in value) {
      return value.text || value.hyperlink;
    }
  }

  return value ?? '';
}

export async function processUpload(uploadId) {
  const upload = await Upload.findById(uploadId)
    .select('+storagePath');

  if (!upload) {
    throw new Error('Upload not found');
  }

  upload.status = 'processing';
  await upload.save();

  try {
    const ext = path.extname(upload.originalName).toLowerCase();

    const uploadPolicy =
      (await SystemSetting.findOne({
        key: 'uploadPolicy'
      }).lean())?.value || {};

    const maxRows = Math.min(
      1000,
      Math.max(1, Number(uploadPolicy.maxRowsPerUpload || 1000))
    );

    let rows = [];

    if (ext === '.csv') {
      const content = await fs.readFile(
        upload.storagePath,
        'utf8'
      );

      // Handles quoted values, embedded commas, escaped quotes,
      // and newlines inside quoted CSV fields.
      rows = parseCsv(content, {
        columns: headers =>
          headers.map(header =>
            String(header ?? '')
              .replace(/^\uFEFF/, '')
              .trim()
          ),
        skip_empty_lines: true,
        bom: true,
        relax_column_count: true,
        trim: true,
        skip_records_with_empty_values: false
      }).map((raw, index) => ({
        raw,
        sourceRow: index + 2
      }));
    } else if (ext === '.xlsx') {
      await inspectZipArchive(upload.storagePath);

      const workbook = new ExcelJS.Workbook();
      await workbook.xlsx.readFile(upload.storagePath);

      for (const sheet of workbook.worksheets) {
        if (sheet.rowCount > maxRows + 1) {
          throw new Error(
            `Worksheet ${sheet.name} exceeds the configured row limit of ${maxRows}`
          );
        }

        // Salary statements often have institution/title rows before the
        // actual column headings. Detect the header row instead of assuming row 1.
        let headerRowNumber = 1;
        let headers = [];
        for (let candidate = 1; candidate <= Math.min(sheet.rowCount, 20); candidate++) {
          const candidateHeaders = sheet.getRow(candidate).values.slice(1)
            .map(value => String(cellValue(value) ?? '').trim());
          const normalized = candidateHeaders.map(normalizeKey);
          if (normalized.some(value => ['name', 'name of employee', 'employee name'].includes(value))) {
            headerRowNumber = candidate;
            headers = candidateHeaders;
            break;
          }
        }
        if (!headers.length) {
          headers = sheet.getRow(1).values.slice(1).map(value => String(cellValue(value) ?? '').trim());
        }

        for (
          let rowNumber = headerRowNumber + 1;
          rowNumber <= sheet.rowCount;
          rowNumber++
        ) {
          const values = sheet.getRow(rowNumber).values.slice(1);
          const raw = {};

          headers.forEach((header, index) => {
            if (header) {
              raw[header] = cellValue(values[index]);
            }
          });

          if (
            Object.values(raw).some(value =>
              String(value ?? '').trim() !== ''
            )
          ) {
            rows.push({
              raw,
              sourceSheet: sheet.name,
              sourceRow: rowNumber
            });
          }
        }
      }

      upload.sheetCount = workbook.worksheets.length;
    } else if (ext === '.xls') {
      const workbook = XLSX.readFile(
        upload.storagePath,
        { cellDates: true }
      );

      for (const sheetName of workbook.SheetNames) {
        const sheet = workbook.Sheets[sheetName];

        if (
          sheet['!ref'] &&
          XLSX.utils.decode_range(sheet['!ref']).e.r > maxRows
        ) {
          throw new Error(
            `Worksheet ${sheetName} exceeds the configured row limit of ${maxRows}`
          );
        }

        const records = XLSX.utils.sheet_to_json(sheet, {
          defval: '',
          raw: false
        });

        records.forEach((raw, index) => {
          rows.push({
            raw,
            sourceSheet: sheetName,
            sourceRow: index + 2
          });
        });
      }

      upload.sheetCount = workbook.SheetNames.length;
    } else if (ext === '.pdf') {
      const pdfInfo = await execFileAsync(
        'pdfinfo',
        [upload.storagePath],
        {
          timeout: 10000,
          maxBuffer: 1024 * 1024
        }
      );

      const pageMatch = pdfInfo.stdout.match(/^Pages:\s+(\d+)/m);

      if (pageMatch && Number(pageMatch[1]) > 100) {
        throw new Error(
          'PDF exceeds the 100-page processing limit. Split it into smaller files.'
        );
      }

      const buffer = await fs.readFile(upload.storagePath);
      const parsed = await pdfParse(buffer);

      let text = parsed.text || '';

      if (text.trim().length < 40) {
        text = await ocrPdf(upload.storagePath);
      }

      rows = parseTabularPdf(text).map((raw, index) => ({
        raw,
        sourceRow: index + 1
      }));

      if (!rows.length) {
        throw new Error(
          'Could not detect a table with employee name and email columns. Use a structured CSV/Excel file or correct the PDF layout.'
        );
      }
    } else {
      throw new Error('Unsupported file type');
    }

    if (rows.length > maxRows) {
      throw new Error(
        `Document contains ${rows.length} rows; the configured limit is ${maxRows}. Split the file into smaller uploads.`
      );
    }

    const normalizedRows = rows.map(item => {
      const mapped = mapRow(item.raw);

      return {
        ...item,
        mapped,
        email: String(mapped.email || '')
          .trim()
          .toLowerCase()
      };
    });

    await ExtractedRecord.deleteMany({
      upload: upload._id
    });

    const seenEmails = new Set();

    let validCount = 0;
    let invalidCount = 0;
    let duplicateCount = 0;

    const docs = [];
    for (const item of normalizedRows) {
      const mapped = item.mapped;
      const email = item.email;

      const errors = [];

      let duplicate = false;

      const langValue = String(mapped.language || 'en')
        .trim()
        .toLowerCase();

      const language = ['mr', 'marathi'].includes(langValue)
        ? 'mr'
        : ['hi', 'hindi'].includes(langValue)
          ? 'hi'
          : 'en';

      const rawAmount = String(mapped.salaryAmount ?? '')
        .replace(/[₹,\s]/g, '');

      const salaryAmount =
        rawAmount && Number.isFinite(Number(rawAmount))
          ? rawAmount
          : undefined;

      const uploadedEmail = String(email || '').trim().toLowerCase();
      const uploadedPhone = String(mapped.phone || '').trim();
      const resolvedEmail = uploadedEmail;
      const resolvedPhone = uploadedPhone
        ? normalizePhone(uploadedPhone) || uploadedPhone
        : '';

      errors.push(...validateRecord({
        ...mapped,
        email: resolvedEmail,
        phone: resolvedPhone,
        salaryAmount
      }));

      duplicate = Boolean(resolvedEmail && seenEmails.has(resolvedEmail));
      if (resolvedEmail) seenEmails.add(resolvedEmail);
      if (duplicate) {
        errors.push('Duplicate email address within this document');
        duplicateCount += 1;
      }

      if (errors.length) {
        invalidCount += 1;
      } else {
        validCount += 1;
      }

      docs.push({
        upload: upload._id,
        sourceSheet: item.sourceSheet,
        sourceRow: item.sourceRow,
        raw: item.raw,

        name: String(mapped.name || '').trim(),
        email: resolvedEmail,
        phone: resolvedPhone,
        language,

        // A missing salary remains blank.
        salaryAmount,
        salaryPeriod: String(mapped.salaryPeriod || '').trim(),

        valid: errors.length === 0,
        duplicate,
        errors
      });
    }

    if (docs.length) {
      await ExtractedRecord.insertMany(docs, {
        ordered: false
      });
    }

    upload.status = 'review';
    upload.rowCount = docs.length;
    upload.validCount = validCount;
    upload.invalidCount = invalidCount;
    upload.duplicateCount = duplicateCount;
    upload.processedAt = new Date();

    upload.errors = docs.length
      ? []
      : ['No records found in the document'];

    await upload.save();

    return upload;
  } catch (error) {
    upload.status = 'failed';
    upload.errors = [
      String(
        error.message || 'Document processing failed'
      ).slice(0, 500)
    ];

    await upload.save();
    throw error;
  }
}

export async function sha256File(filePath) {
  const hash = crypto.createHash('sha256');
  const data = await fs.readFile(filePath);

  return hash.update(data).digest('hex');
}