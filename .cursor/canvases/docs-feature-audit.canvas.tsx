import {
	Callout,
	Card,
	CardBody,
	CardHeader,
	Grid,
	H1,
	H2,
	Pill,
	Row,
	Stack,
	Stat,
	Table,
	Text,
	useCanvasState
} from 'cursor/canvas';
import catalog from '../../docs/feature-catalog.json';

type Tab = 'summary' | 'catalog' | 'gaps' | 'structure';
type Coverage = 'Covered' | 'Thin' | 'Missing' | 'Stale';
type Feature = {
	id: string;
	area: string;
	feature: string;
	currentCoverage: Coverage;
	currentDocs: string;
	targetPage: string;
	action: string;
	priority: string;
};

const features = catalog.features as Feature[];
const assigned = features.filter((feature) => feature.targetPage);
const uncovered = features.filter((feature) => feature.currentCoverage !== 'Covered');

const pageGroups = [
	{
		title: 'Start',
		pages: ['introduction', 'install', 'connect-provider', 'quickstart', 'tour/interface']
	},
	{
		title: 'Write',
		pages: [
			'write/files-and-tabs',
			'write/editor',
			'write/images-and-diagrams',
			'write/find-and-appearance',
			'write/pdfs-and-other-files'
		]
	},
	{
		title: 'Use the agent',
		pages: [
			'agent/ask-and-steer',
			'agent/selected-text-and-directives',
			'agent/plans-and-long-tasks',
			'agent/review-edits',
			'agent/comments-and-critique',
			'agent/customize',
			'agent/sessions-and-history'
		]
	},
	{
		title: 'Automate',
		pages: [
			'automation/hooks',
			'automation/events',
			'automation/preview',
			'automation/latex-and-synctex',
			'automation/example-projects'
		]
	},
	{
		title: 'Help',
		pages: [
			'help/provider-errors',
			'help/storage-and-backups',
			'help/external-edits',
			'help/recovery',
			'help/privacy-and-safety',
			'help/shortcuts',
			'help/command-line'
		]
	},
	{
		title: 'Contribute',
		pages: [
			'contribute/setup',
			'contribute/architecture',
			'contribute/providers-and-tools',
			'contribute/editor-and-persistence',
			'contribute/testing-and-docs'
		]
	}
];

const priorityWork = [
	['P0', 'Rewrite the product description', 'Lead with the shared writing workspace description.'],
	['P0', 'Rewrite onboarding', 'Make installation, provider connection, and one accepted edit accurate.'],
	['P0', 'Rewrite the interface tour', 'Show the source editor, comment gutter, and floating agent dock.'],
	['P0', 'Correct review guidance', 'Remove the outline pane, FIFO, Retry, and Track changes claims.'],
	['P0', 'Correct provider setup', 'Cover five providers, credentials, model search, and custom models.'],
	['P0', 'Correct storage guidance', 'Explain server-owned Yjs, SQLite, and Markdown backup files.'],
	['P0', 'Correct session reset', 'Explain what New session clears and what it preserves.'],
	['P1', 'Document editor media', 'Cover images, links, SVG, D3, tables, and code blocks.'],
	['P1', 'Document agent controls', 'Cover wake, pause, mute, cancel, queueing, and autonomy.'],
	['P1', 'Document plans and questions', 'Cover plan review, question cards, timeouts, and long tasks.'],
	['P1', 'Document sessions and history', 'Cover browsing, transcripts, cost, context, and export.'],
	['P1', 'Document previews and SyncTeX', 'Cover PDF tabs, split preview, hooks, and both sync directions.'],
	['P1', 'Document persistence and recovery', 'Cover external edits, restarts, stale proposals, and scratch.'],
	['P1', 'Finish or remove guide stubs', 'Publish tested Pandoc, Mermaid, and Git procedures.'],
	['P1', 'Add troubleshooting', 'Organize fixes by the symptom a user sees.'],
	['P2', 'Add privacy and safety', 'Explain provider data, key storage, hooks, web requests, and paths.'],
	['P2', 'Add contributor guidance', 'Separate development and architecture details from the user guide.']
];

function App() {
	const [tab, setTab] = useCanvasState<Tab>('active-tab', 'summary');
	const [coverage, setCoverage] = useCanvasState<Coverage | 'All'>('coverage', 'All');
	const visible =
		coverage === 'All'
			? features
			: features.filter((feature) => feature.currentCoverage === coverage);

	return (
		<Stack gap={20} style={{ maxWidth: 1200, margin: '0 auto', padding: 24 }}>
			<Stack gap={8}>
				<H1>DocWriter documentation audit</H1>
				<Text tone="secondary">
					Every shipped feature has one planned documentation page. Current coverage and
					future ownership are separate fields, so a stale feature can still have a clear
					destination.
				</Text>
			</Stack>

			<Row gap={8} wrap>
				{[
					['summary', 'Summary'],
					['catalog', 'Feature catalog'],
					['gaps', 'Missing and stale'],
					['structure', 'Proposed structure']
				].map(([id, label]) => (
					<div key={id}>
						<Pill active={tab === id} onClick={() => setTab(id as Tab)}>
							{label}
						</Pill>
					</div>
				))}
			</Row>

			{tab === 'summary' && (
				<Stack gap={18}>
					<Grid columns={4} gap={14}>
						<Stat value={features.length} label="Shipped features" />
						<Stat value={assigned.length} label="Assigned to a page" tone="success" />
						<Stat value={uncovered.length} label="Need documentation work" tone="warning" />
						<Stat
							value={features.length - assigned.length}
							label="Unassigned features"
							tone={assigned.length === features.length ? 'success' : 'danger'}
						/>
					</Grid>
					<Callout tone="info" title="Recommended product description">
						DocWriter is a shared writing workspace where you and an AI agent work alongside
						each other in the same live draft.
					</Callout>
					<Callout tone="neutral" title="How to use the audit">
						The catalog is the source of truth. The gap view is derived from the catalog, and
						the structure view lists the features assigned to each page.
					</Callout>
				</Stack>
			)}

			{tab === 'catalog' && (
				<Stack gap={12}>
					<Row gap={8} wrap>
						{(['All', 'Covered', 'Thin', 'Missing', 'Stale'] as const).map((item) => (
							<div key={item}>
								<Pill active={coverage === item} onClick={() => setCoverage(item)}>
									{item}
								</Pill>
							</div>
						))}
					</Row>
					<Table
						headers={['Area', 'Feature', 'Current coverage', 'Target page', 'Action', 'Priority']}
						rows={visible.map((feature) => [
							feature.area,
							feature.feature,
							feature.currentCoverage,
							feature.targetPage,
							feature.action,
							feature.priority
						])}
						striped
						stickyHeader
					/>
				</Stack>
			)}

			{tab === 'gaps' && (
				<Stack gap={16}>
					<H2>Priority work</H2>
					<Table headers={['Priority', 'Work', 'Definition of done']} rows={priorityWork} striped />
					<H2>Complete missing and stale list</H2>
					<Table
						headers={['Area', 'Feature', 'Coverage', 'Target page']}
						rows={uncovered.map((feature) => [
							feature.area,
							feature.feature,
							feature.currentCoverage,
							feature.targetPage
						])}
						striped
						stickyHeader
					/>
				</Stack>
			)}

			{tab === 'structure' && (
				<Stack gap={16}>
					<H2>Six documentation sections</H2>
					<Text tone="secondary">
						Each page lists every feature it owns. The assignment count must equal the
						catalog count before the rewrite begins.
					</Text>
					<Grid columns={2} gap={14}>
						{pageGroups.map((group) => (
							<div key={group.title}>
								<Card collapsible defaultOpen={group.title === 'Start'}>
									<CardHeader>{group.title}</CardHeader>
									<CardBody>
										<Stack gap={12}>
											{group.pages.map((page) => {
												const pageFeatures = features.filter(
													(feature) => feature.targetPage === page
												);
												return (
													<Stack gap={4} key={page}>
														<Text weight="semibold">
															{page} ({pageFeatures.length})
														</Text>
														{pageFeatures.length > 0 ? (
															pageFeatures.map((feature) => (
																<Text size="small" tone="secondary" key={feature.id}>
																	{feature.feature}
																</Text>
															))
														) : (
															<Text size="small" tone="tertiary">
																Contributor or onboarding page with no separate shipped feature row.
															</Text>
														)}
													</Stack>
												);
											})}
										</Stack>
									</CardBody>
								</Card>
							</div>
						))}
					</Grid>
				</Stack>
			)}
		</Stack>
	);
}

export default App;
