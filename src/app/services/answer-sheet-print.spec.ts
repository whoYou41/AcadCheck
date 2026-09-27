import { AnswerKeyService } from './answer-key.service';
import { of } from 'rxjs';
describe('Blank answer sheet printing', () => {
  for (const offline of [true,false]) it('uses the supplied blank form, offline=' + offline, () => {
    const service:any = Object.create(AnswerKeyService.prototype);
    service.auth={isOfflineMode:()=>offline};
    service.offline={getAnswerKey:()=>{throw new Error('Correct answers must not be read for sheet printing');}};
    service.http={get:jasmine.createSpy('asset').and.returnValue(of(new Blob()))};
    service.downloadAnswerSheet(1).subscribe();
    expect(service.http.get).toHaveBeenCalledOnceWith('assets/answer-sheet/print.html',{responseType:'blob'});
  });
});
