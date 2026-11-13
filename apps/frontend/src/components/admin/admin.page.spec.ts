import { labelTableCells } from './admin.page';

// On a phone each admin table row is a card of "Label  value" lines
// (mobile.scss .admin-page); the labels come from the header row.
describe('labelTableCells', () => {
  const html = (body: string) => {
    const root = document.createElement('div');
    root.innerHTML = body;
    return root;
  };

  it('gives every cell its column name', () => {
    const root = html(`<table>
      <thead><tr><th>User</th><th> Billing state </th><th></th></tr></thead>
      <tbody><tr><td>a@b.c</td><td>Active</td><td><button>View</button></td></tr></tbody>
    </table>`);
    labelTableCells(root);
    const cells = [...root.querySelectorAll('td')].map((td) => td.getAttribute('data-label'));
    expect(cells).toEqual(['User', 'Billing state', '']);
  });

  it('counts colspan, so later cells keep their own column', () => {
    const root = html(`<table>
      <thead><tr><th>A</th><th>B</th><th>C</th></tr></thead>
      <tbody><tr><td colspan="2">wide</td><td>c</td></tr></tbody>
    </table>`);
    labelTableCells(root);
    const cells = [...root.querySelectorAll('td')].map((td) => td.getAttribute('data-label'));
    expect(cells).toEqual(['A', 'C']);
  });

  it('labels each table from its own header and leaves headerless tables alone', () => {
    const root = html(`
      <table><thead><tr><th>Date</th></tr></thead><tbody><tr><td>1 Nov</td></tr></tbody></table>
      <table><tbody><tr><td>no header</td></tr></tbody></table>`);
    labelTableCells(root);
    const [first, second] = [...root.querySelectorAll('td')];
    expect(first.getAttribute('data-label')).toBe('Date');
    expect(second.hasAttribute('data-label')).toBe(false);
  });

  it('does not rewrite a label that is already right (no observer loop)', () => {
    const root = html(`<table><thead><tr><th>X</th></tr></thead><tbody><tr><td>1</td></tr></tbody></table>`);
    labelTableCells(root);
    const td = root.querySelector('td')!;
    const spy = jest.spyOn(td, 'setAttribute');
    labelTableCells(root);
    expect(spy).not.toHaveBeenCalled();
  });
});

// Touch screens: every admin control is at least 44px (mobile.scss
// .admin-touch). The page, the journey drawer and AdminDialog carry the class
// (the drawer and dialog are portals on <body>, outside the page).
describe('admin tap targets', () => {
  /* eslint-disable @typescript-eslint/no-var-requires */
  const fs = require('fs');
  const path = require('path');
  /* eslint-enable @typescript-eslint/no-var-requires */
  const read = (rel: string) => fs.readFileSync(path.join(__dirname, rel), 'utf8');

  it('mobile.scss sets 44px on buttons, fields and section tabs under a coarse pointer', () => {
    const scss = read('../../app/mobile.scss');
    const block = scss.slice(scss.indexOf('.admin-touch') - 200);
    expect(block).toMatch(/@media \(pointer: coarse\)/);
    expect(block).toMatch(/\.admin-touch :is\(button, select/);
    expect(block).toMatch(/min-height: 44px/);
    expect(block).toMatch(/min-width: 44px/);
    expect(block).toMatch(/nav\[aria-label='Admin sections'\] a/);
  });

  it.each(['admin.page.tsx', 'admin.dialog.tsx', 'admin-users.component.tsx'])(
    '%s marks its container admin-touch',
    (file) => {
      expect(read(file)).toMatch(/className="[^"]*\badmin-touch\b/);
    }
  );

  it('the section tabs carry the label the stylesheet selects on', () => {
    expect(read('admin.header.tsx')).toContain('aria-label="Admin sections"');
  });
});
