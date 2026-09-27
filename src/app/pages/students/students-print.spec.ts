import { StudentsPage } from './students.page';
describe('Classroom import and roster printing', () => {
  let page: any;
  beforeEach(() => {
    page = Object.create(StudentsPage.prototype);
    page.showToastMessage = jasmine.createSpy('toast');
  });
  it('previews a multiword first name and imports its exact separated fields', () => {
    page.bulkText = 'John Reelan E. Altobar | Male';
    page.bulkDefaultGender = null;
    page.parseBulkText();
    expect(page.validBulkStudents.length).toBe(1);
    expect(page.validBulkStudents[0]).toEqual(jasmine.objectContaining({firstName:'John Reelan',middleName:'E.',lastName:'Altobar',gender:'male'}));
  });
  it('blocks duplicates and ambiguous lines before bulk import', () => {
    page.bulkText = 'John Reelan E. Altobar\nJohn Reelan E. Altobar\nJohn Reelan Altobar';
    page.bulkDefaultGender = 'male';
    page.parseBulkText();
    expect(page.validBulkStudents.length).toBe(1);
    expect(page.invalidBulkStudents.length).toBe(2);
  });
  it('prints every selected-classroom student with safe text in sequence order', async () => {
    let html = '';
    const popup: any = {closed:false,focus:()=>{},print:jasmine.createSpy('print'),document:{
      title:'',body:{textContent:''},images:[],fonts:{ready:Promise.resolve()},open:()=>{},close:()=>{},write:(value:string)=>html=value
    }};
    spyOn(window,'open').and.returnValue(popup);
    page.allStudents = [
      {classroomId:2,firstName:'Other classroom',lastName:'Z',sequentialNumber:1},
      {classroomId:1,firstName:'John Reelan',middleName:'E.',lastName:'Altobar',sequentialNumber:2},
      {classroomId:1,firstName:'<script>',middleName:'A.',lastName:'First',sequentialNumber:1}
    ];
    page.filteredStudents=[];
    await page.printStudentList({id:1,name:'ITE & 323',section:'B'});
    expect(html).toContain('John Reelan');
    expect(html).toContain('Middle initial');
    expect(html).toContain('&lt;script&gt;');
    expect(html).toContain('ITE &amp; 323');
    expect(html).not.toContain('Other classroom');
    expect(html.indexOf('First')).toBeLessThan(html.indexOf('Altobar'));
    expect(popup.print).toHaveBeenCalledTimes(1);
  });
});
