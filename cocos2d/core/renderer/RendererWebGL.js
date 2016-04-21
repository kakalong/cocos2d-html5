/****************************************************************************
 Copyright (c) 2013-2014 Chukong Technologies Inc.

 http://www.cocos2d-x.org

 Permission is hereby granted, free of charge, to any person obtaining a copy
 of this software and associated documentation files (the "Software"), to deal
 in the Software without restriction, including without limitation the rights
 to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 copies of the Software, and to permit persons to whom the Software is
 furnished to do so, subject to the following conditions:

 The above copyright notice and this permission notice shall be included in
 all copies or substantial portions of the Software.

 THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
 THE SOFTWARE.
 ****************************************************************************/

cc.rendererWebGL = (function () {

function removeByLastSwap (array, i) {
    var len = array.length;
    if (len > 0 && i >= 0 && i < len) {
        array[i] = array[len - 1];
        array.length--;
    }
}

var CACHING_BUFFER = true;
var ACTIVATE_AUTO_BATCH = true;

// Internal variables
    // Batching general informations
var _batchedInfo = {
        // The batched texture, all batching element should have the same texture
        texture: null,
        // The batched blend source, all batching element should have the same blend source
        blendSrc: null,
        // The batched blend destination, all batching element should have the same blend destination
        blendDst: null,
        // The batched shader, all batching element should have the same shader
        shader: null
    },
    // to compare with the batched info
    _currentInfo = {
        texture: null,
        blendSrc: null,
        blendDst: null,
        shader: null
    },
    // The current virtual buffer
    _currentBuffer = null,
    _batchBufferPool = new cc.SimplePool(),
    _orderDirtyInFrame = false,
    _bufferError = false,
    _prevRenderCmds = [],
    _quadIndexBuffer = {
        buffer: null,
        maxQuads: 0
    };

// Inspired from @Heishe's gotta-batch-them-all branch
// https://github.com/Talisca/cocos2d-html5/commit/de731f16414eb9bcaa20480006897ca6576d362c
function updateQuadIndexBuffer (numQuads) {
    if (!_quadIndexBuffer.buffer) {
        return;
    }
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, _quadIndexBuffer.buffer);

    var indices = new Uint16Array(numQuads * 6);
    var currentQuad = 0;
    for (var i = 0, len = numQuads * 6; i < len; i += 6) {
        indices[i] = currentQuad + 0;
        indices[i + 1] = currentQuad + 1;
        indices[i + 2] = currentQuad + 2;
        indices[i + 3] = currentQuad + 1;
        indices[i + 4] = currentQuad + 2;
        indices[i + 5] = currentQuad + 3;
        currentQuad += 4;
    }
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, indices, gl.STATIC_DRAW);
}

// Inspired from @Heishe's gotta-batch-them-all branch
// https://github.com/Talisca/cocos2d-html5/commit/de731f16414eb9bcaa20480006897ca6576d362c
function getQuadIndexBuffer (numQuads) {
    if (_quadIndexBuffer.buffer === null) {
        _quadIndexBuffer.buffer = gl.createBuffer();
    }

    if (_quadIndexBuffer.maxQuads < numQuads) {
        updateQuadIndexBuffer(numQuads);
    }

    return _quadIndexBuffer.buffer;
}

function createVirtualBuffer (buffer, vertexOffset, matrixOrigin, matrixOffset, totalBufferSize, count, data) {
    data = data || new Uint32Array(totalBufferSize / 4);
    var vBuf = {
        // The object contains real WebGL buffers, it's created or retrieved via getBatchBuffer
        buffer: buffer,
        // The vertex data array (Uint32Array)
        dataArray: data,
        // The start offset in the vertex buffer, in bytes
        vertexOffset: vertexOffset,
        // The offset of all matrix data, in bytes
        matrixOrigin: matrixOrigin,
        // The start offset after the origin of matrix data in the vertex buffer, in bytes
        matrixOffset: matrixOffset,
        // Total vertex array buffer size, including vertex data and matrix data, in bytes
        totalBufferSize: totalBufferSize,
        // Render command count
        count: count
    };
    return vBuf;
}

return {
    childrenOrderDirty: true,
    assignedZ: 0,
    assignedZStep: 1/10000,

    _transformNodePool: [],                              //save nodes transform dirty
    _renderCmds: [],                                     //save renderer commands

    _isCacheToBufferOn: false,                          //a switch that whether cache the rendererCmd to cacheToCanvasCmds
    _cacheToBufferCmds: {},                              // an array saves the renderer commands need for cache to other canvas
    _cacheInstanceIds: [],
    _currentID: 0,
    _clearColor: cc.color(),                            //background color,default BLACK

    getRenderCmd: function (renderableObject) {
        //TODO Add renderCmd pool here
        return renderableObject._createRenderCmd();
    },

    _turnToCacheMode: function (renderTextureID) {
        this._isCacheToBufferOn = true;
        renderTextureID = renderTextureID || 0;
        this._cacheToBufferCmds[renderTextureID] = [];
        this._cacheInstanceIds.push(renderTextureID);
        this._currentID = renderTextureID;
    },

    _turnToNormalMode: function () {
        this._isCacheToBufferOn = false;
    },

    /**
     * drawing all renderer command to cache canvas' context
     * @param {Number} [renderTextureId]
     */
    _renderingToBuffer: function (renderTextureId) {
        renderTextureId = renderTextureId || this._currentID;
        var locCmds = this._cacheToBufferCmds[renderTextureId], i, len;
        var ctx = cc._renderContext, locIDs = this._cacheInstanceIds;
        for (i = 0, len = locCmds.length; i < len; i++) {
            locCmds[i].rendering(ctx);
        }
        locCmds.length = 0;
        delete this._cacheToBufferCmds[renderTextureId];
        cc.arrayRemoveObject(locIDs, renderTextureId);

        if (locIDs.length === 0)
            this._isCacheToBufferOn = false;
        else
            this._currentID = locIDs[locIDs.length - 1];
    },

    //reset renderer's flag
    resetFlag: function () {
        if (this.childrenOrderDirty) {
            _orderDirtyInFrame = true;
            this.childrenOrderDirty = false;
        }
        this._transformNodePool.length = 0;
    },

    //update the transform data
    transform: function () {
        var locPool = this._transformNodePool;
        //sort the pool
        locPool.sort(this._sortNodeByLevelAsc);
        //transform node
        var i, len, cmd;
        for (i = 0, len = locPool.length; i < len; i++) {
            cmd = locPool[i];
            cmd.updateStatus();
        }
        locPool.length = 0;
    },

    transformDirty: function () {
        return this._transformNodePool.length > 0;
    },

    _sortNodeByLevelAsc: function (n1, n2) {
        return n1._curLevel - n2._curLevel;
    },

    pushDirtyNode: function (node) {
        //if (this._transformNodePool.indexOf(node) === -1)
        this._transformNodePool.push(node);
    },

    clearRenderCommands: function () {
        // Copy previous command list for late check in rendering
        if (CACHING_BUFFER) {
            var locCmds = this._renderCmds;
            var i, len = locCmds.length, cmd;
            for (i = 0; i < len; ++i) {
                cmd = locCmds[i];
                cmd._currId = -1;
                _prevRenderCmds[i] = cmd;
            }
            _prevRenderCmds.length = len;
        }
        this._renderCmds.length = 0;
    },

    clear: function () {
        var gl = cc._renderContext;
        gl.clearColor(this._clearColor.r, this._clearColor.g, this._clearColor.b, this._clearColor.a);
        gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    },

    setDepthTest: function (enable){
        var gl = cc._renderContext;
        if(enable){
            gl.clearDepth(1.0);
            gl.enable(gl.DEPTH_TEST);
            gl.depthFunc(gl.LEQUAL);
        }
        else{
            gl.disable(gl.DEPTH_TEST);
        }
    },
    
    pushRenderCommand: function (cmd) {
        if(!cmd._needDraw)
            return;
        if (this._isCacheToBufferOn) {
            var currentId = this._currentID, locCmdBuffer = this._cacheToBufferCmds;
            var cmdList = locCmdBuffer[currentId];
            if (cmdList.indexOf(cmd) === -1)
                cmdList.push(cmd);
        } else {
            if (this._renderCmds.indexOf(cmd) === -1) {
                cmd._currId = this._renderCmds.length;
                this._renderCmds.push(cmd);
            }
        }
    },

    // Auto batch implementation inspired from @Heishe 's PR
    // Ref: https://github.com/cocos2d/cocos2d-html5/pull/3248
    createBatchBuffer: function (bufferSize) {
        var arrayBuffer = gl.createBuffer();

        this.initBatchBuffers(arrayBuffer, bufferSize);

        return {arrayBuffer: arrayBuffer, bufferSize: bufferSize};
    },

    // Auto batch implementation inspired from @Heishe 's PR
    // Ref: https://github.com/cocos2d/cocos2d-html5/pull/3248
    initBatchBuffers: function (arrayBuffer, bufferSize) {
        gl.bindBuffer(gl.ARRAY_BUFFER, arrayBuffer);
        gl.bufferData(gl.ARRAY_BUFFER, bufferSize, gl.DYNAMIC_DRAW);
    },

    // Auto batch implementation inspired from @Heishe 's PR
    // Ref: https://github.com/cocos2d/cocos2d-html5/pull/3248

    // Returns an object with {arrayBuffer, size}, 
    // where size denotes how many unit fit in the buffer (no need for bufferData if it's already big enough, bufferSubData enough)
    getBatchBuffer: function(bufferSize)
    {
        if (_batchBufferPool.size() > 0) {
            var minSize = Number.MAX_VALUE; 
            var minBufIndex = -1;

            var buf = _batchBufferPool.find(function (i, buf) {
                // Find available buffer with suitable size
                if (buf.bufferSize >= bufferSize) {
                    return true;
                }

                // Track the smallest found buffer because that one will be re-initialized and returned if no fitting buffer can be found
                if (buf.bufferSize < minSize)
                {
                    minSize = buf.bufferSize;
                    minBufIndex = i;
                }
            }, function () {
                return minBufIndex;
            });

            if (buf) {
                this.initBatchBuffers(buf.arrayBuffer, bufferSize);
                buf.bufferSize = bufferSize;
                return buf;
            }
        }

        return this.createBatchBuffer(bufferSize);
    },

    _refreshVirtualBuffers: function () {
        var renderCmds = this._renderCmds,
            len = _prevRenderCmds.length,
            i = 0, j = 0, end, cmd1, cmd2, next, 
            newBuf, currBuf,
            startId, count;

        // Loop previous render command list to compare with current command list
        for (; i < len; ++i) {
            cmd1 = _prevRenderCmds[i];
            currBuf = cmd1._vBuffer;
            matched = false;
            // Check to update virtual buffer
            if (currBuf) {
                j = cmd1._currId;
                // Removed from the command list
                if (j < 0) {
                    cmd1._vBuffer = null;
                    continue;
                }

                cmd1.getBatchInfo(_batchedInfo);
                startId = i;
                count = 0;
                // Remains in the command list
                cmd2 = renderCmds[j];
                while (cmd1 === cmd2 && cmd1._vBuffer === currBuf) {
                    ++count;
                    ++j;
                    cmd1 = _prevRenderCmds[i+count];
                    cmd2 = renderCmds[j];
                }
                end = i + count;

                // No valid batch
                if (count <= 1) {
                    // Set both in case cmd1 doesn't equal cmd2
                    cmd1._vBuffer = cmd2._vBuffer = null;
                    continue;
                }

                // The next command in the current list support batch
                if (cmd2._supportBatch) {
                    cmd2.getBatchInfo(_currentInfo);
                    if (_currentInfo.texture === _batchedInfo.texture &&
                        _currentInfo.blendSrc === _batchedInfo.blendSrc &&
                        _currentInfo.blendDst === _batchedInfo.blendDst &&
                        _currentInfo.shader === _batchedInfo.shader) {
                        // Old batch dirty, clean up v buffer properties
                        for (; i < end; ++i) {
                            _prevRenderCmds[i]._vBuffer = null;
                        }
                        continue;
                    }
                }

                // Perfect match
                if (currBuf.count === count) {
                    i = i + count - 1;
                }
                // Sub match
                else if (count > 1) {
                    // First command in buffer
                    cmd1 = _prevRenderCmds[i];
                    newBuf = createVirtualBuffer(currBuf.buffer, 
                                                 cmd1._vertexOffset, 
                                                 currBuf.matrixOrigin,
                                                 cmd1._matrixOffset,
                                                 currBuf.totalBufferSize, 
                                                 count,
                                                 currBuf.dataArray);
                    for (; i < end; ++i) {
                        _prevRenderCmds[i]._vBuffer = newBuf;
                    }
                }
            }
        }

        // Forward batch other commands
        len = renderCmds.length;
        for (i = 0; i < len; ++i) {
            cmd1 = renderCmds[i];
            // Already batched command, do not update
            if (cmd1._vBuffer) {
                continue;
            }

            next = renderCmds[i+1];
            // Batching
            if (cmd1._supportBatch && next && next._supportBatch) {
                count = this._forwardBatch(i);
                if (count > 1) {
                    // i will increase by 1 each loop
                    i += count - 1;
                    continue;
                }
            }
        }
        _prevRenderCmds.length = 0;
        _bufferError = false;
    },

    // Forward search commands that are in the same virtual buffer, 
    // If size match then no problem to render
    // Otherwise, the virtual buffer need to be updated
    _forwardCheck: function (first) {
        var renderCmds = this._renderCmds,
            cmd = renderCmds[first],
            last = first, length = renderCmds.length,
            vbuffer = cmd._vBuffer;

        // Reset current buffer and batched info
        cmd.getBatchInfo(_batchedInfo);
        _currentBuffer = null;

        // Protection, vbuffer invalid or doesn't match the command
        if (cmd._vertexOffset !== vbuffer.vertexOffset || !vbuffer.buffer) {
            _bufferError = true;
            return 0;
        }

        // Forward check
        var matrixBuffer, martixOrigin;
        for (; last < length; ++last) {
            cmd = renderCmds[last];
            if (vbuffer !== cmd._vBuffer) {
                break;
            }

            // Lazy update transform matrix in buffer
            if (cmd._savedDirtyFlag) {
                if (!matrixBuffer) {
                    // Bind buffer
                    matrixBuffer = vbuffer;
                    martixOrigin = matrixBuffer.matrixOrigin / 4;
                    gl.bindBuffer(gl.ARRAY_BUFFER, matrixBuffer.buffer.arrayBuffer);
                }
                cmd.batchVertexBuffer(matrixBuffer.dataArray, cmd._vertexOffset, martixOrigin, cmd._matrixOffset);
                cmd._savedDirtyFlag = false;
            }
        }
        // Send last buffer to WebGLBuffer
        if (matrixBuffer) {
            gl.bufferSubData(gl.ARRAY_BUFFER, 0, matrixBuffer.dataArray);
        }

        var size = last - first;
        // no problem
        if (vbuffer.count === size) {
            _currentBuffer = vbuffer;
            return size;
        }
        // buffer errored
        // need to update virtual buffers in next frame
        else {
            for (last = first; last < first + size; ++last) {
                cmd = renderCmds[last];
                cmd._vBuffer = null;
            }
            _bufferError = true;
            return 0;
        }
    },

    // Auto batch implementation inspired from @Heishe 's PR
    // Ref: https://github.com/cocos2d/cocos2d-html5/pull/3248
    // Forward search commands that can be batched together
    _forwardBatch: function (first) {
        var renderCmds = this._renderCmds,
            cmd = renderCmds[first],
            last = first + 1, length = renderCmds.length;

        if (!cmd || !cmd._supportBatch)
            return 0;

        // Initialize batched info
        cmd.getBatchInfo(_batchedInfo);
        if (!_batchedInfo.texture)
            return 0;

        var matrixOrigin = cmd.vertexBytesPerUnit;
        var totalBufferSize = cmd.bytesPerUnit;

        // Forward search and collect batch informations
        cmd = renderCmds[last];
        while (cmd) {
            if (cmd._supportBatch) {
                cmd.getBatchInfo(_currentInfo);
            }
            else {
                break;
            }
            // Batch info don't match, break batching
            if (_currentInfo.texture !== _batchedInfo.texture ||
                _currentInfo.blendSrc !== _batchedInfo.blendSrc ||
                _currentInfo.blendDst !== _batchedInfo.blendDst ||
                _currentInfo.shader !== _batchedInfo.shader) {
                break;
            }
            else {
                matrixOrigin += cmd.vertexBytesPerUnit;
                totalBufferSize += cmd.bytesPerUnit;
            }
            ++last;
            cmd = renderCmds[last];
        }

        var count = last - first;
        // Can't batch, fall back to original render command
        if (count <= 1) {
            return count;
        }

        var buffer = this.getBatchBuffer(totalBufferSize);

        // Create a virtual buffer
        var vbuffer = createVirtualBuffer(buffer, 
                                          0, 
                                          matrixOrigin,
                                          0,
                                          totalBufferSize, 
                                          count);
        _currentBuffer = vbuffer;
        var uploadBuffer = vbuffer.dataArray;

        //all of the divisions by 4 are just because we work with uint32arrays instead of uint8 arrays so all indexes need to be shortened by the factor of 4
        var totalVertexData = matrixOrigin / 4;
        var vertexDataOffset = 0;
        var matrixDataOffset = 0;

        // Bind vertex data buffer
        gl.bindBuffer(gl.ARRAY_BUFFER, vbuffer.buffer.arrayBuffer);

        // Fill in vertex data command by command
        var i;
        for (i = first; i < last; ++i) {
            cmd = renderCmds[i];
            cmd.batchVertexBuffer(uploadBuffer, vertexDataOffset, totalVertexData, matrixDataOffset);

            if (CACHING_BUFFER) {
                cmd._vBuffer = vbuffer;
                cmd._vertexOffset = vertexDataOffset;
                cmd._matrixOffset = matrixDataOffset;
            }
            if (cmd._savedDirtyFlag) {
                cmd._savedDirtyFlag = false;
            }

            vertexDataOffset += cmd.vertexBytesPerUnit / 4;
            matrixDataOffset += cmd.matrixBytesPerUnit / 4;
        }

        // Submit vertex data in one bufferSubData call
        gl.bufferSubData(gl.ARRAY_BUFFER, 0, uploadBuffer);

        if (!CACHING_BUFFER) {
            _batchBufferPool.put(buffer);
        }
        return count;
    },

    // Auto batch implementation inspired from @Heishe 's PR
    // Ref: https://github.com/cocos2d/cocos2d-html5/pull/3248
    // Batch rendering using result collected in `_forwardBatch`
    _batchRendering: function () {
        // var node = this._node;
        var texture = _batchedInfo.texture;
        var shader = _batchedInfo.shader;
        var count = _currentBuffer.count;

        var bytesPerRow = 16; //4 floats with 4 bytes each

        shader.use();
        shader._updateProjectionUniform();

        cc.glBlendFunc(_batchedInfo.blendSrc, _batchedInfo.blendDst);
        cc.glBindTexture2DN(0, texture);                   // = cc.glBindTexture2D(texture);

        gl.bindBuffer(gl.ARRAY_BUFFER, _currentBuffer.buffer.arrayBuffer);

        cc.glEnableVertexAttribs(cc.VERTEX_ATTRIB_FLAG_POS_COLOR_TEX);

        var vertexOffset = _currentBuffer.vertexOffset;
        gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 24, vertexOffset);
        gl.vertexAttribPointer(1, 4, gl.UNSIGNED_BYTE, true, 24, vertexOffset + 12);
        gl.vertexAttribPointer(2, 2, gl.FLOAT, false, 24, vertexOffset + 16);
        
        var i;
        var matrixOffset = _currentBuffer.matrixOrigin + _currentBuffer.matrixOffset;
        // Enable matrix vertex attribs row by row (vec4 * 4)
        for (i = 0; i < 4; ++i) {
            gl.enableVertexAttribArray(cc.VERTEX_ATTRIB_MVMAT0 + i);
            gl.vertexAttribPointer(cc.VERTEX_ATTRIB_MVMAT0 + i, 4, gl.FLOAT, false, bytesPerRow * 4, matrixOffset + bytesPerRow * i); //stride is one row
        }

        var elemBuffer = getQuadIndexBuffer(count);
        gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, elemBuffer);
        gl.drawElements(gl.TRIANGLES, count * 6, gl.UNSIGNED_SHORT, 0);

        for (i = 0; i < 4; ++i) {
            gl.disableVertexAttribArray(cc.VERTEX_ATTRIB_MVMAT0 + i);
        }

        cc.g_NumberOfDraws++;
    },

    /**
     * drawing all renderer command to context (default is cc._renderContext)
     * @param {WebGLRenderingContext} [ctx=cc._renderContext]
     */
    rendering: function (ctx) {
        var locCmds = this._renderCmds,
            i, len, cmd, next, batchCount,
            context = ctx || cc._renderContext;

        // Only update virtual buffers if children order dirty in the current frame
        if (ACTIVATE_AUTO_BATCH && (_orderDirtyInFrame || _bufferError)) {
            this._refreshVirtualBuffers();
        }

        for (i = 0, len = locCmds.length; i < len; i++) {
            cmd = locCmds[i];
            next = locCmds[i+1];

            if (ACTIVATE_AUTO_BATCH) {
                // Already batched in buffer
                if (cmd._vBuffer) {
                    batchCount = this._forwardCheck(i);
                    if (batchCount > 1) {
                        this._batchRendering();
                        // i will increase by 1 each loop
                        i += batchCount - 1;
                        continue;
                    }
                }
            }

            cmd.rendering(context);
        }
        if (_orderDirtyInFrame) {
            _orderDirtyInFrame = false;
        }
    }
};
})();