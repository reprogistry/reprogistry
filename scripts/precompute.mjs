#!/usr/bin/env node

import { execSync } from 'child_process';
import { mkdirSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';

const OUTPUT_DIR = process.argv[2] || 'precompute-output/packages';

// Ensure output directory exists
mkdirSync(OUTPUT_DIR, { recursive: true });

// Get list of packages from data branch
const packagesRaw = execSync('git show origin/data:packages.txt', { encoding: 'utf8' });
const packageList = packagesRaw.trim().split('\n').filter(Boolean);

console.log(`Processing ${packageList.length} packages...`);

/**
 * @typedef {{ name: string, latestVersion: string, latestScore: number | null, versionCount: number, majorCount: number, averageScore: number, reproducedPercent: number, perfectlyReproduced: number, excellent: number, partiallyReproduced: number, failed: number }} PackageIndexEntry
 */

/** @type {PackageIndexEntry[]} */
const packageIndex = [];

/**
 * Get the "major" version key for filtering
 * For 0.0.X, X is the major; for 0.X.Y, X is the major; for X.Y.Z (X>0), X is the major
 * @param {string} version
 * @returns {string}
 */
function getMajorKey(version) {
	const parts = version.replace(/^v/, '').split('.');
	const major = parseInt(parts[0], 10) || 0;
	const minor = parseInt(parts[1], 10) || 0;
	const patch = parseInt(parts[2], 10) || 0;

	if (major === 0) {
		if (minor === 0) {
			return '0.0.' + patch;
		}
		return '0.' + minor;
	}
	return String(major);
}

/**
 * Compare two versions (for sorting newest-first)
 * @param {string} a
 * @param {string} b
 * @returns {number}
 */
function compareVersions(a, b) {
	const aParts = a.replace(/^v/, '').split('.').map((p) => parseInt(p, 10) || 0);
	const bParts = b.replace(/^v/, '').split('.').map((p) => parseInt(p, 10) || 0);

	for (let i = 0; i < Math.max(aParts.length, bParts.length); i++) {
		const aVal = aParts[i] || 0;
		const bVal = bParts[i] || 0;
		if (aVal !== bVal) {
			return bVal - aVal; // Descending (newest first)
		}
	}
	return 0;
}

/**
 * Get only the latest version in each major
 * @template {{ version: string }} T
 * @param {T[]} versions
 * @returns {T[]}
 */
function getLatestPerMajor(versions) {
	// Sort newest first
	const sorted = versions.slice().sort((a, b) => compareVersions(a.version, b.version));

	/** @type {Record<string, T>} */
	const latestByMajor = {};
	for (const v of sorted) {
		const key = getMajorKey(v.version);
		if (!latestByMajor[key]) {
			latestByMajor[key] = v;
		}
	}
	return Object.values(latestByMajor);
}

/**
 * @param {string} safePkg
 * @param {string} vDir
 */
const processVersion = function (safePkg, vDir) {
	// vDir is like "v1.0.0"
	const version = vDir.slice(1); // Remove 'v' prefix

	try {
		const resultRaw = execSync(`git show origin/data:results/${safePkg}/${vDir}`, { encoding: 'utf8' });
		const results = JSON.parse(resultRaw);
		const latest = results[0];

		if (!latest) {
			return null;
		}

		// Get score from diff summary
		const score = latest.diff && latest.diff.summary ? latest.diff.summary.score : null;

		return {
			reproduced: latest.reproduced,
			score,
			timestamp: latest.timestamp,
			version,
		};
	} catch {
		// Skip versions that can't be parsed
		return null;
	}
};

/** @param {string} pkg */
const processPackage = function (pkg) {
	try {
		// Get list of versions for this package
		const safePkg = pkg.startsWith('@') ? pkg : pkg;
		const versionsRaw = execSync(`git ls-tree origin/data:results/${safePkg} --name-only 2>/dev/null || true`, { encoding: 'utf8' });
		const versionDirs = versionsRaw.trim().split('\n').filter(Boolean);

		if (versionDirs.length === 0) {
			return;
		}

		const versions = /** @type {{ reproduced: boolean, score: number | null, timestamp: string, version: string }[]} */ (
			versionDirs
				.map((vDir) => processVersion(safePkg, vDir))
				.filter(Boolean)
		);

		if (versions.length === 0) {
			return;
		}

		// Sort by version (semver descending would be better, but simple string sort for now)
		versions.sort((a, b) => b.version.localeCompare(a.version, undefined, { numeric: true }));

		const output = {
			name: pkg,
			versions,
		};

		// Write package file
		const safeFilename = pkg.replace('/', '__');
		const outputPath = join(OUTPUT_DIR, `${safeFilename}.json`);
		writeFileSync(outputPath, JSON.stringify(output));

		// Calculate stats based on latest per major (matching dashboard/scripts/precompute.mjs)
		const latestPerMajor = getLatestPerMajor(versions);
		const majorCount = latestPerMajor.length;

		let perfectlyReproduced = 0;
		let excellent = 0;
		let partiallyReproduced = 0;
		let failed = 0;
		let totalScore = 0;
		let scoredCount = 0;

		for (const v of latestPerMajor) {
			const score = v.score;
			if (score !== null && score !== undefined) {
				totalScore += score;
				scoredCount++;

				if (score === 1) {
					perfectlyReproduced++;
				} else if (score >= 0.9) {
					excellent++;
				} else if (score >= 0.8) {
					partiallyReproduced++;
				} else {
					failed++;
				}
			}
		}

		const averageScore = scoredCount > 0 ? totalScore / scoredCount : 0;

		// Add to index
		const latest = versions[0];
		packageIndex.push({
			averageScore,
			excellent,
			failed,
			latestScore: latest.score,
			latestVersion: latest.version,
			majorCount,
			name: pkg,
			partiallyReproduced,
			perfectlyReproduced,
			reproducedPercent: Math.round(averageScore * 100),
			versionCount: versions.length,
		});

		console.log(`  ${pkg}: ${versions.length} versions, ${majorCount} majors, ${Math.round(averageScore * 100)}% reproduced`);
	} catch (e) {
		const err = /** @type {Error} */ (e);
		console.error(`  Error processing ${pkg}:`, err.message);
	}
};

packageList.forEach(processPackage);

// Calculate overall stats
const totalPackages = packageIndex.length;
const totalVersions = packageIndex.reduce((sum, p) => sum + p.versionCount, 0);
const totalMajors = packageIndex.reduce((sum, p) => sum + p.majorCount, 0);
const totalPerfect = packageIndex.reduce((sum, p) => sum + p.perfectlyReproduced, 0);
const totalExcellent = packageIndex.reduce((sum, p) => sum + p.excellent, 0);
const totalPartial = packageIndex.reduce((sum, p) => sum + p.partiallyReproduced, 0);
const totalFailed = packageIndex.reduce((sum, p) => sum + p.failed, 0);

// Weight by majorCount since averageScore is already based on latest-per-major
const weightedScore = packageIndex.reduce((sum, p) => sum + (p.averageScore * p.majorCount), 0);
const overallAverageScore = totalMajors > 0 ? weightedScore / totalMajors : 0;

// Write packages index with stats
const indexPath = join(dirname(OUTPUT_DIR), 'packages.json');
const indexData = {
	packages: packageIndex,
	stats: {
		averageScore: overallAverageScore,
		excellent: totalExcellent,
		failed: totalFailed,
		overallReproducedPercent: Math.round(overallAverageScore * 100),
		partiallyReproduced: totalPartial,
		perfectlyReproduced: totalPerfect,
		totalMajors,
		totalPackages,
		totalVersions,
	},
	generatedAt: new Date().toISOString(),
};
writeFileSync(indexPath, JSON.stringify(indexData));
console.log(`\nWrote index with ${packageIndex.length} packages to ${indexPath}`);
console.log(`Overall reproducibility: ${indexData.stats.overallReproducedPercent}%`);

console.log('Done.');
