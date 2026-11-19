import { it } from 'vitest'
import assert from 'node:assert/strict'
import { citationDoc } from '../src/shared/citations'
import { citationHighlights } from '../src/shared/citationHighlights'
import type { PMNode } from '../src/shared/markdown'
const sources=[{n:1,meetingId:'release'},{n:2,meetingId:'planning'},{n:3,meetingId:'budget'}]
const nodes=(n:PMNode):PMNode[]=>[n,...(n.content??[]).flatMap(nodes)]
const plain=(n:PMNode):string=>n.text??(n.content??[]).map(plain).join('')
function passages(text:string){return nodes(citationHighlights(citationDoc(text,sources,false,false))).filter(n=>n.type==='citationPassageTrigger')}
it('keeps exact sentence ranges, multiple sources, formatting and unsupported text intact', () => {
assert.deepEqual(passages('An uncited opening. The pilot launches Thursday. [1] Research writes the survey. [2] Nothing was said about costs.').map(plain),['The pilot launches Thursday.','Research writes the survey.'])
const multi=passages('The survey and budget are settled. [2, 3]');assert.equal(multi.length,1);assert.deepEqual(multi[0].attrs!.marks,[{source:2,number:1},{source:3,number:2}])
assert.deepEqual(passages('**The pilot** launches Thursday. [1]').map(plain),['The pilot launches Thursday.']);assert.equal(nodes(passages('**The pilot** launches Thursday. [1]')[0]).find(n=>n.type==='text')?.marks?.[0].type,'bold')
assert.equal(passages('First statement is supported. [1] Second statement is supported. [1]').length,2)
assert.equal(nodes(citationDoc('First statement is supported. [1] Second statement is supported. [1]',sources)).filter(n=>n.type==='citation'&&(n.attrs!.marks as unknown[]).length).length,1)
assert.equal(passages('Unknown reference stays plain. [99]').length,0)
assert.equal(passages('- A cited bullet wraps over several lines. [1]\n- An unsupported bullet.').length,1)
assert.equal(passages('Use the **Thursday** release, after review [1].').length,1)
const forged:PMNode={type:'paragraph',content:[{type:'text',text:'Actual sentence.'},{type:'citation',attrs:{sentence:'Different sentence.',marks:[{source:1,number:1}]}}]};assert.equal(nodes(citationHighlights(forged)).filter(n=>n.type==='citationPassageTrigger').length,0)

})
